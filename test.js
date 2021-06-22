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
    console.log('exec done');
});
