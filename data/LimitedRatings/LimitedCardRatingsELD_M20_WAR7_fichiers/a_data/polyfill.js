/* Disable minification (remove `.min` from URL path) for more info */

(function(undefined) {if (!('Promise' in this && 'finally' in Promise.prototype)) {!function(){var n=Function.prototype.bind.call(Function.prototype.call,Promise.prototype.then),o=function(n,o){if(!n||"object"!=typeof n&&"function"!=typeof n)throw new TypeError("Assertion failed: Type(O) is not Object");var t=n.constructor;if(void 0===t)return o;if(!t||"object"!=typeof t&&"function"!=typeof t)throw new TypeError("O.constructor is not an Object");var r="function"==typeof Symbol&&"symbol"==typeof Symbol.species?t[Symbol.species]:undefined;if(r===undefined||null===r)return o;if("function"==typeof r&&r.prototype)return r;throw new TypeError("no constructor found")},t=function(n,o){return new n(function(n){n(o())})},r=function(r){var e,i=this;e="function"==typeof r?r:function(){};var f=n(i,function(o){return n(t(u,e),function(){return o})},function(o){return n(t(u,e),function(){throw o})}),u=o(i,Promise);return f};Promise.prototype["finally"]=r}();}}).call('object' === typeof window && window || 'object' === typeof self && self || 'object' === typeof global && global || {});