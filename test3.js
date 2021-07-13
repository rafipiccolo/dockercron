const http = require('http');

const options = {
    host: '111.111.111.111',
    port: 8080,
    path: '/length_request',
};

// Make a request
const req = http.request(options);
req.end();

req.on('information', (info) => {
    console.log(`Got information prior to main response: ${info.statusCode}`);
});

process.on('uncaughtException', async (err) => {
    err = err ?? {};
    console.trace();
    console.log('-----------');
    console.log(err);
    console.log('-----------');
    console.log(Object.getOwnPropertyNames(err));
    console.log('-----------');
    process.exit(1);
});
