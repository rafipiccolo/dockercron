let LineStream = require('byline').LineStream;

let Docker = require('dockerode');
let docker = new Docker({
    protocol: 'ssh',
    host: '2i.raphaelpiccolo.com',
    port: 22,
    username: 'root',
    sshOptions: {
        privateKey: require('fs').readFileSync('/root/.ssh/id_rsa'),
    },
});
let containerid = process.argv[2];
let container = docker.getContainer(containerid);
let params = {
    Cmd: ['sh', '-c', 'ls'],
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Env: [],
};
console.log('exec');
container.exec(params, (err, exec) => {
    console.log(err);
    console.log('exec done');
});

// (async() => {
//     const stream = await docker.getEvents({});
//     let lineStream = new LineStream({ encoding: 'utf8' });
//     stream.pipe(lineStream);
//     lineStream.on('data', async (chunk) => {
//         let data = JSON.parse(chunk);

//         if (data.Type == 'service') {
//             if (data.Action == 'update') {
//                 console.log('update', data);
//             }

//             if (data.Action == 'create') {
//                 console.log('create', data);
//             } else if (data.Action == 'remove') {
//                 console.log('remove', data);
//             }
//         }
//     });
// })()
