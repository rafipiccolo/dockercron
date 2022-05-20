import fs from 'fs';
import byline from 'byline';
const LineStream = byline.LineStream;
import Docker from 'dockerode';
const docker = new Docker({
    protocol: 'ssh',
    host: 'gextra.net',
    port: 22,
    username: 'root',
    sshOptions: {
        privateKey: fs.readFileSync('/root/.ssh/id_rsa'),
    },
});

import dockerExec from './lib/dockerExec.js';

// let containerId = '6a844a45c2d5bb4bc916b8bce34961cd4ce981280a5edf6b4bcb60361da3c7c4';
const containerId = '255830f250b0a834706dbefe2cb3ddeea357916f8db6300f156c7a9640e2db4c';

dockerExec(docker, 'root@gextra.net', containerId, { name: 'test', command: `sleep 300`, timeout: 2 }, (err, data) => {
    if (err) return console.log(err);

    console.log(data);
});

// let containerid = process.argv[2];
// let container = docker.getContainer(containerid);
// let params = {
//     Cmd: ['sh', '-c', 'ls'],
//     AttachStdin: false,
//     AttachStdout: true,
//     AttachStderr: true,
//     Tty: false,
//     Env: [],
// };
// console.log('exec');
// container.exec(params, (err, exec) => {
//     console.log(err);
//     console.log('exec done');
// });

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
