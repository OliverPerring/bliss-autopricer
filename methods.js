var Methods = function() {};
var fs = require('fs');
const path = require('path');

const axios = require('axios');
const AsyncLock = require('async-lock');
const lock = new AsyncLock();

const config = require('./config.json');
const CACHE_FILE_PATH = path.resolve(__dirname, 'cached-pricelist.json');

Methods.prototype.halfScrapToRefined = function(halfscrap) {
    var refined = parseFloat((halfscrap / 18).toString().match(/^-?\d+(?:\.\d{0,2})?/)[0]);
    return refined;
};

Methods.prototype.refinedToHalfScrap = function(refined) {
    var halfScrap = parseFloat((refined * 18).toString().match(/^-?\d+(?:\.\d{0,2})?/)[0]);
    return halfScrap;
};

// Rounds the metal value to the nearest scrap.
Methods.prototype.getRight = function(v) {
    var i = Math.floor(v),
        f = Math.round((v - i) / 0.11);
    return parseFloat((i + (f === 9 ? 1 : f * 0.11)).toFixed(2));
  };

// This method first takes the amount of keys the item costs and multiplies it by
// the current key metal sell price. This gives us the amount of metal the key cost
// is worth in terms of a keys current sell price. Then it adds this result onto
// the metal cost. It's then rounded down to the nearest 0.11.

// From here, the metal (being both the worth of the keys and the metal value), is
// divided into the sell price of a key. Totalling the amount of keys that could be
// afforded with the pure metal value. The metal component is calculated by taking the
// remainder of the rounded total value divided by keyPrice. This gives the amount of
// metal that couldn't be converted into a whole key.

// This method ensures we make prices that take into account the current price of the key.
Methods.prototype.parsePrice = function(original, keyPrice) {
    // Defensive: ensure keys is always an integer
    if (!Number.isInteger(original.keys)) {
        console.error('parsePrice called with non-integer keys:', original);
        original.keys = Math.trunc(original.keys);
    }
    var metal = this.getRight(original.keys * keyPrice) + original.metal;
    return {
        keys: Math.trunc(metal / keyPrice),
        metal: this.getRight(metal % keyPrice)
    };
};

Methods.prototype.toMetal = function(obj, keyPriceInMetal) {
    var metal = 0;
    metal += obj.keys * keyPriceInMetal;
    metal += obj.metal;
    return this.getRight(metal);
};

Methods.prototype.calculatePercentageDifference = function(value1, value2) {
    if (value1 === 0) {
        return value2 === 0 ? 0 : 100; // Handle division by zero
    }
    return ((value2 - value1) / Math.abs(value1)) * 100;
};

// Calculate percentage differences and decide on rejecting or accepting the autopricers price
// based on limits defined in config.json.
Methods.prototype.calculatePricingAPIDifferences = function(pricetfItem, final_buyObj, final_sellObj, keyobj) {
    var percentageDifferences = {};

    var sell_Price_In_Metal = this.toMetal(final_sellObj, keyobj.metal);
    var buy_Price_In_Metal = this.toMetal(final_buyObj, keyobj.metal);

    var priceTFSell = {};
    priceTFSell.keys = pricetfItem.sell.keys;
    priceTFSell.metal = pricetfItem.sell.metal;

    var priceTFBuy = {};
    priceTFBuy.keys = pricetfItem.buy.keys;
    priceTFBuy.metal = pricetfItem.buy.metal;

    var priceTF_Sell_Price_In_Metal = this.toMetal(priceTFSell, keyobj.metal);
    var priceTF_Buy_Price_In_Metal = this.toMetal(priceTFBuy, keyobj.metal);

    var results = {};
    results.priceTFSellPrice = priceTF_Sell_Price_In_Metal;
    results.autopricerSellPrice = sell_Price_In_Metal;
    results.priceTFBuyPrice = priceTF_Buy_Price_In_Metal;
    results.autopricerBuyPrice = buy_Price_In_Metal;

    percentageDifferences.buyDifference = this.calculatePercentageDifference(
        results.priceTFBuyPrice,
        results.autopricerBuyPrice
    );
    percentageDifferences.sellDifference = this.calculatePercentageDifference(
        results.priceTFSellPrice,
        results.autopricerSellPrice
    );

    // Ensures that data we're going to use in comparison are numbers. If not we throw an error.
    if (isNaN(percentageDifferences.buyDifference) || isNaN(percentageDifferences.sellDifference)) {
        // Can't compare percentages because the external API likely returned malformed data.
        throw new Error('External API returned NaN. Critical error.');
    }
    // Calls another method that uses this percentage difference object to make decision on whether to use our autopricers price or not.
    try {
        var usePrice = this.validatePrice(percentageDifferences);
        // We should use this price, resolves as true.
        return usePrice;
    } catch (e) {
        // We should not use this price.
        throw new Error(e);
    }
};

Methods.prototype.validatePrice = function(item, buyPrice, sellPrice) {
    const minMargin = config.minSellMargin || 0.11;
    
    // Basic validation rules:
    // 1. Sell price must be higher than buy price
    if (sellPrice.metal <= buyPrice.metal) return false;
    
    // 2. Margin must be at least minMargin
    const margin = sellPrice.metal - buyPrice.metal;
    if (margin < minMargin) return false;
    
    return true;
};

Methods.prototype.waitXSeconds = async function(seconds) {
    return new Promise(resolve => {
        // Convert to miliseconds and then set timeout.
        setTimeout(resolve, seconds * 1000);
    });
};

Methods.prototype.validateObject = function(obj) {
    // Check if the object is undefined, empty etc.
    if(!obj) {
        return false;
    }
    if(Object.keys(obj).length > 0) {
        if(obj.hasOwnProperty('keys') || obj.hasOwnProperty('metal')) {
            // The object is valid as it contains at least one expected key.
            return true;
        } else {
            // The object is invalid as it doesn't contain any expected keys.
            return false;
        }
    } else {
        // The object is empty.
        return false;
    }
};

Methods.prototype.createCurrencyObject = function(obj) {
    let newObj = {
        keys: 0,
        metal: 0
    };

    if (obj.hasOwnProperty('keys')) {
        newObj.keys = obj.keys;
    }

    if (obj.hasOwnProperty('metal')) {
        newObj.metal = obj.metal;
    }

    return newObj;
};

const comparePrices = (item1, item2) => {
    return item1.keys === item2.keys && item1.metal === item2.metal;
};

Methods.prototype.addToPricelist = function(item, PRICELIST_PATH) {
    try {
        lock.acquire('pricelist', () => {
            const data = fs.readFileSync(PRICELIST_PATH, 'utf8');
            let existingData = JSON.parse(data);
            let items = Array.isArray(existingData.items) ? existingData.items : [];

            // Filter out empty or malformed items
            items = items.filter(i => i && i.name && i.sku && i.buy && i.sell);

            // Validate new item
            if (!item || !item.name || !item.sku || !item.buy || !item.sell) {
                console.error('Attempted to add malformed item to pricelist:', item);
                return;
            }

            // Sanity check: prevent absurd prices
            if (
                item.sell.metal > 1000 || item.buy.metal > 1000
            ) {
                console.error(`[ERROR] Abnormal price for ${item.name}:`, item);
                return;
            }

            const existingIndex = items.findIndex(pricelist_item => pricelist_item.sku === item.sku);

            if (existingIndex !== -1) {
                items[existingIndex] = item;
            } else {
                items.push(item);
            }

            existingData.items = items;

            // Atomic write
            const tempPath = PRICELIST_PATH + '.tmp';
            fs.writeFileSync(tempPath, JSON.stringify(existingData, null, 2), 'utf8');
            fs.renameSync(tempPath, PRICELIST_PATH);
        });
    } catch (error) {
        console.error('Error:', error);
    }
};

// Request related methods.
// This method is now deprecated on Backpack.tf and will not work.
Methods.prototype.getListingsFromSnapshots = async function(name) {
    try {
        // Endpoint is limited to 1 request per 60 seconds.
        await this.waitXSeconds(1);
        const response = await axios.get(`https://backpack.tf/api/classifieds/listings/snapshot`, {
            params: {
                sku: name,
                appid: 440,
                token: config.bptfToken
            }
        });
        if (response.status === 200) {
            const listings = response.data.listings;
            return listings;
        } else {
            throw new Error("Rate limited.");
        }
    } catch (error) {
        throw error;
    }
};

Methods.prototype.getKeyPriceFromBackpackTF = async function() {
    try {
        const response = await axios.get('https://backpack.tf/api/IGetPrices/v4', {
            params: {
                key: config.bptfAPIKey,
                appid: 440,
                tradable: 1,
                craftable: 1
            }
        });
        
        if (response.status === 200) {
            const keyData = response.data.items['Mann Co. Supply Crate Key'];
            if (!keyData) throw new Error('Key price not found');
            
            const keyPrice = {
                metal: parseFloat(keyData.prices[6].Tradable.Craftable[0].value) 
            };
            
            return keyPrice;
        }
    } catch (error) {
        console.error('Failed to get key price:', error);
        throw error;
    }
};

Methods.prototype.getKeyFromExternalAPI = async function() {
    let key_object = {};

    try {
        const axiosConfig = await this.getJWTFromPricesTF(1, 100);

        let tries = 1;
        while (tries <= 5) {
            const response = await axios.get('https://api2.prices.tf/prices/5021;6', axiosConfig);

            if (response.status === 200) {
                key_object.name = 'Mann Co. Supply Crate Key';
                key_object.sku = '5021;6';
                key_object.source = 'bptf';

                let buyKeys = Object.is(response.data.buyKeys, undefined) ? 0 : response.data.buyKeys;

                let buyMetal = this.halfScrapToRefined(
                    Object.is(response.data.buyHalfScrap, undefined) ? 0 : response.data.buyHalfScrap
                );

                buyMetal = this.getRight(buyMetal);

                key_object.buy = {
                    keys: buyKeys,
                    metal: buyMetal
                };

                let sellKeys = Object.is(response.data.sellKeys, undefined) ? 0 : response.data.sellKeys;

                let sellMetal = this.halfScrapToRefined(
                    Object.is(response.data.sellHalfScrap, undefined) ? 0 : response.data.sellHalfScrap
                );

                sellMetal = this.getRight(sellMetal);

                key_object.sell = {
                    keys: sellKeys,
                    metal: sellMetal
                };

                key_object.time = Math.floor(Date.now() / 1000);

                return key_object;
            } 

            // Wait 10 seconds between retries. I want to ensure that this succeeds as the key price is very important.
            await this.waitXSeconds(10);
            tries++;
        }

        throw new Error('Failed to get key price from Prices.TF. It is either down or we are being rate-limited.');
    } catch (error) {
        throw error;
    }
};

module.exports = Methods;
