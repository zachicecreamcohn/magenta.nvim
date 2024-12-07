console.error('hello from magenta')
require("@swc-node/register")
const plugin = require("./magenta.ts")
module.exports = plugin
