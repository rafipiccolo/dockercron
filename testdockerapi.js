let dockerapi = require('./lib/dockerapi.js');

(async () => {
    // let localsocket = `${__dirname}/proxy.sock`;
    // let host = '2i.raphaelpiccolo.com';
    // let remotesocket = '/var/run/docker.sock';
    // await dockerapi.createTunnel(localsocket, host, remotesocket);

    console.log('run command');

    let data = null;

    // data = await dockerapi.info({
    //     host: 'localhost',
    //     timeout: 100000,
    // });

    // data = await dockerapi.listTasks({
    //     host: 'localhost',
    //     timeout: 10000,
    //     filters: {
    //         service: ['swarm_traefik'],
    //         'desired-state': ['running'],
    //     },
    // })

    // data = await dockerapi.listNodes({
    //     host: 'localhost',
    //     timeout: 10000
    // })

    // data = await dockerapi.listServices({
    //     host: 'localhost',
    //     timeout: 10000
    // })

    // data = await dockerapi.listContainers({
    //     host: 'localhost',
    //     timeout: 10000
    // })

    // data = await dockerapi.getService({
    //     host: 'localhost',
    //     id: 'oezjzv1h9j93',
    //     timeout: 10000
    // })

    // data = await dockerapi.getContainer({
    //     host: 'localhost',
    //     id: '973bc3bb0ead',
    //     timeout: 10000
    // })

    // data = await dockerapi.getNode({
    //     host: 'localhost',
    //     id: 'vbm7lnt32br1tq6tfkxgl22oz',
    //     timeout: 10000
    // })

    // await dockerapi.getEvents({
    //     host: 'localhost',
    //     onLine: console.log,
    // });

    data = await dockerapi.exec({
        host: 'localhost',
        id: '80a94720d71d',
        options: { AttachStdin: false, AttachStdout: true, AttachStderr: true, DetachKeys: 'ctrl-p,ctrl-q', Tty: false, Cmd: ['ls', '-la'] },
        onLine: (line) => console.log('line', line),
        timeout: 10000,
    });

    console.log('run command done');
    console.log(data);

    process.exit(0);
})();
