var port = 8678;
var configFile = 'config.txt';

var rewrites = [];
parseConfig(configFile);

require('fs').watch(configFile, function() {
    parseConfig(configFile);
});


require('proxy').createServer(function(url) {
    for (var i = 0; i < rewrites.length; i++) {
        if (rewrites[i].pattern.test(url)) {
            return url.replace(rewrites[i].pattern, rewrites[i].replacement);
        }
    }
    return url;
}).listen(port);


function parseConfig(fname) {
    require('config-parser').parse(fname, function(err, result) {
        if (err) {
            console.log('Config parse error: ' + err.message);
            return;
        }
        rewrites = result;
    });
}