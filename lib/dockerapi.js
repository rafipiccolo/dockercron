import http from 'http';
import fs from 'fs';
import { spawn } from 'child_process';
import readline from 'readline';
import execFilePromise from './execFilePromise.js';
import { Transform } from 'stream';
import queue from './queue.js';
import delay from './delay.js';

function demux(stream) {
    // let source = Buffer.from('\x01\x00\x00\x00\x03\x00\x00\x00hi!\x02\x00\x00\x00\x02\x00\x00\x00ho');

    const stdout = new Transform({
        transform(chunk, encoding, callback) {
            callback(null, chunk);
        },
    });

    const stderr = new Transform({
        transform(chunk, encoding, callback) {
            callback(null, chunk);
        },
    });

    let source = Buffer.from('');
    stream.on('data', (data) => {
        source = Buffer.concat([source, data]);

        // parse buffer
        let index = 0;
        while (index < source.length) {
            // pas assez de données => on skip
            // sinon on parse l'int qui contient le canal : stdout, stderr
            if (index + 4 > source.length) break;
            const canal = source.readUInt8(index);

            // pas assez de données => on skip
            // sinon on parse l'int qui contient le nombre de caracteres disponibles
            if (index + 8 > source.length) break;
            const nb = source.readUInt32BE(index + 4);

            // pas assez de données => on skip
            // sinon on recupere tous les caracteres
            if (index + 8 + nb > source.length) break;
            const data = source.slice(index + 8, index + 8 + nb);

            // on push dans les sous streams et on recommence
            if (canal == 1) stdout.write(data);
            else if (canal == 2) stderr.write(data);
            else throw new Error('bad canal found');

            index = index + 8 + nb;
        }

        // supprime ce qu'on a parsé
        source = source.slice(index);
    });

    return { stdout, stderr };
}

const tunnels = {};

const safeGetTunnel = queue(getTunnel);

async function getTunnel(host) {
    // tunnel deja créé : on renvoie le path de la socket unix
    if (tunnels[host]) return tunnels[host];

    // sinon on crée le tunnel
    const localsocket = `/tmp/proxy.${host}.sock`;
    const remotesocket = '/var/run/docker.sock';
    const tunnel = await createTunnel(localsocket, host, remotesocket);

    tunnels[host] = localsocket;
    return localsocket;
}

async function dockerApi(host, method, path, postdata, timeout, onLine, needdemux) {
    // get the unixsocket for docker : create tunnel to it
    let socketPath = '/var/run/docker.sock';
    if (host) socketPath = await safeGetTunnel(host);

    return new Promise((resolve, reject) => {
        const options = {
            socketPath,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
            },
        };

        let x = null;
        if (timeout)
            x = setTimeout(() => {
                const err = new Error(`timeout when ${path}`);
                err.code = 'TIMEOUT';
                reject(err);
            }, timeout * 1000);

        const clientRequest = http.request(options, (res) => {
            let body = '';

            if (needdemux) {
                const { stdout, stderr } = demux(res);
                stdout.setEncoding('utf8');
                stdout.on('data', (data) => {
                    if (onLine) onLine(data);
                });
                stderr.setEncoding('utf8');
                stderr.on('data', (data) => {
                    if (onLine) onLine(data);
                });
            } else {
                res.setEncoding('utf8');
                if (onLine) {
                    const rl = readline.createInterface({ input: res });
                    rl.on('line', onLine);
                    rl.on('error', (err) => {
                        reject(new Error('readline error'));
                    });
                } else {
                    res.on('data', (data) => {
                        body += data;
                    });
                }
            }

            res.on('aborted', () => console.log('aborted'));
            res.on('error', (err) => {
                reject(new Error('res error'));
            });

            res.on('end', () => {
                if (x) clearTimeout(x);

                resolve({
                    statusCode: res.statusCode,
                    body,
                });
            });

            res.on('error', (err) => reject(err));
        });

        if (postdata) clientRequest.write(JSON.stringify(postdata));

        clientRequest.end();
    });
}

async function unlinkifexist(file) {
    try {
        await fs.promises.unlink(file);
    } catch (err) {
        if (err.code != 'ENOENT') throw err;
    }
}

async function createTunnel(localsocket, host, remotesocket) {
    let dejacall = false;

    console.log('create tunnel :', 'ssh', '-L', `${localsocket}:${remotesocket}`, '-qC', host);

    // créer le tunnel
    await unlinkifexist(localsocket);

    // -q réduit les logs, (semble pas necessaire)
    // -N permet de ne pas executer de commande (par defaut c'est un shell qui est lancé)
    // il ne faut pas mettre -N car sinon ssh ne serait pas kill en cas de crash de nodejs, un zombie va persister
    // si on met -N, et qu'on envoie SIGHUP à ssh le tunnel va se fermer
    // si on met -N et qu'on a spécifié une commande, par exemple "sleep 10" le tunnel va se lancer et attendre 10 secondes qu'une autre commande soit lancée.
    // Le tunnel se fermera des qu'il n'y aura plus de commande ni de sleep en cours.
    // -T permet de ne pas allouer de tty, (semble pas necessaire)
    // -C permet de compresser, (semble pas necessaire)
    // -n permet d'ignorer stdin, (nike tout à moins d'avoir activé N => donc pas cool)
    // -f permet de passer le process en background (semble as necessaire + necessite de passer une commande)
    const tunnel = spawn('ssh', ['-L', `${localsocket}:${remotesocket}`, '-qC', host]);

    tunnel.stdout.on('data', (data) => {
        console.log(`stdout: ${data}`);
    });
    tunnel.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
    });
    tunnel.on('close', async (code) => {
        console.log(`tunnel closed with code ${code}`);

        if (!dejacall) {
            dejacall = true;
            await unlinkifexist(localsocket);

            await delay(5000);

            await createTunnel(localsocket, host, remotesocket);
        }
    });
    tunnel.on('error', async (err) => {
        console.log(err);

        if (!dejacall) {
            dejacall = true;
            await unlinkifexist(localsocket);

            await delay(5000);

            await createTunnel(localsocket, host, remotesocket);
        }
    });

    await delay(3000);

    return tunnel;
}

function closeTunnel(tunnel) {
    tunnel.kill('SIGHUP');
}

// ssh 2i.raphaelpiccolo.com "curl --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X GET http://localhost/v1.41/info"
async function info(params) {
    const { statusCode, body } = await dockerApi(params.host, 'GET', `/${process.env.DOCKER_API_VERSION}/info`, null, params.timeout);

    if (statusCode >= 300) throw new Error(`bad statusCode ${statusCode} while info`);

    return JSON.parse(body);
}

// ssh 2i.raphaelpiccolo.com "curl --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X GET http://localhost/v1.41/tasks"
async function listTasks(params) {
    let url = `/${process.env.DOCKER_API_VERSION}/tasks`;

    if (params.filters) url += `?filters=${JSON.stringify(params.filters)}`;

    const { statusCode, body } = await dockerApi(params.host, 'GET', url, null, params.timeout);

    if (statusCode >= 300) throw new Error(`bad statusCode ${statusCode} while listTasks ${body}`);

    return JSON.parse(body);
}

// ssh 2i.raphaelpiccolo.com "curl --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X GET http://localhost/v1.41/tasks/xxxxx"
async function getTask(params) {
    const { statusCode, body } = await dockerApi(params.host, 'GET', `/${process.env.DOCKER_API_VERSION}/tasks/${params.id}`, null, params.timeout);

    if (statusCode >= 300) throw new Error(`bad statusCode ${statusCode} while getTask`);

    return JSON.parse(body);
}

// ssh 2i.raphaelpiccolo.com "curl --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X GET http://localhost/v1.41/nodes"
async function listNodes(params) {
    const { statusCode, body } = await dockerApi(params.host, 'GET', `/${process.env.DOCKER_API_VERSION}/nodes`, null, params.timeout);

    if (statusCode >= 300) throw new Error(`bad statusCode ${statusCode} while listNodes`);

    return JSON.parse(body);
}

// ssh 2i.raphaelpiccolo.com "curl --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X GET http://localhost/v1.41/nodes/igmtibnqiwfy0wgwkr7b8l3fd"
async function getNode(params) {
    const { statusCode, body } = await dockerApi(params.host, 'GET', `/${process.env.DOCKER_API_VERSION}/nodes/${params.id}`, null, params.timeout);

    if (statusCode >= 300) throw new Error(`bad statusCode ${statusCode} while getNode`);

    return JSON.parse(body);
}

// ssh 2i.raphaelpiccolo.com "curl --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X GET http://localhost/v1.41/services"
async function listServices(params) {
    const { statusCode, body } = await dockerApi(params.host, 'GET', `/${process.env.DOCKER_API_VERSION}/services`, null, params.timeout);

    if (statusCode >= 300) throw new Error(`bad statusCode ${statusCode} while listServices`);

    return JSON.parse(body);
}

// ssh 2i.raphaelpiccolo.com "curl --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X GET http://localhost/v1.41/containers/json"
async function listContainers(params) {
    const { statusCode, body } = await dockerApi(params.host, 'GET', `/${process.env.DOCKER_API_VERSION}/containers/json`, null, params.timeout);

    if (statusCode >= 300) throw new Error(`bad statusCode ${statusCode} while listContainers`);

    return JSON.parse(body);
}

// ssh 2i.raphaelpiccolo.com "curl --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X GET http://localhost/v1.41/services/oezjzv1h9j93"
async function getService(params) {
    const { statusCode, body } = await dockerApi(
        params.host,
        'GET',
        `/${process.env.DOCKER_API_VERSION}/services/${params.id}`,
        null,
        params.timeout
    );

    if (statusCode >= 300) throw new Error(`bad statusCode ${statusCode} while getService`);

    return JSON.parse(body);
}

// ssh 2i.raphaelpiccolo.com "curl --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X GET http://localhost/v1.41/containers/973bc3bb0ead/json"
async function getContainer(params) {
    const { statusCode, body } = await dockerApi(
        params.host,
        'GET',
        `/${process.env.DOCKER_API_VERSION}/containers/${params.id}/json`,
        null,
        params.timeout
    );

    if (statusCode >= 300) throw new Error(`bad statusCode ${statusCode} while getContainer`);

    return JSON.parse(body);
}

// ssh 2i.raphaelpiccolo.com "curl --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X GET http://localhost/v1.41/exec/973bc3bb0ead/json"
async function getExec(params) {
    const { statusCode, body } = await dockerApi(
        params.host,
        'GET',
        `/${process.env.DOCKER_API_VERSION}/exec/${params.id}/json`,
        null,
        params.timeout
    );

    if (statusCode >= 300) throw new Error(`bad statusCode ${statusCode} while getExec`);

    return JSON.parse(body);
}

// ssh 2i.raphaelpiccolo.com "curl --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X GET http://localhost/v1.41/events"
async function getEvents(params) {
    return await dockerApi(params.host, 'GET', `/${process.env.DOCKER_API_VERSION}/events`, null, params.timeout, (line) => {
        if (params.onLine) params.onLine(JSON.parse(line));
    });
}

/*
container.exec
ssh 2i.raphaelpiccolo.com "curl --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X POST http://localhost/v1.41/containers/973bc3bb0ead/exec -d '{ \"AttachStdin\": false, \"AttachStdout\": true, \"AttachStderr\": true, \"DetachKeys\": \"ctrl-p,ctrl-q\", \"Tty\": false, \"Cmd\": [ \"date\" ] }'"
je get ça: { "Id": "072b4c2e242b86bc3e00e117a32345d0db242cd16b9076822f708b8b295f1f33" }
ssh 2i.raphaelpiccolo.com "curl --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X POST http://localhost/v1.41/exec/072b4c2e242b86bc3e00e117a32345d0db242cd16b9076822f708b8b295f1f33/start -d {}"
ssh 2i.raphaelpiccolo.com "curl --unix-socket /var/run/docker.sock -H 'Content-Type: application/json' -X GET http://localhost/v1.41/exec/072b4c2e242b86bc3e00e117a32345d0db242cd16b9076822f708b8b295f1f33/json"
je get ça: { "ID": "072b4c2e242b86bc3e00e117a32345d0db242cd16b9076822f708b8b295f1f33", "Running": false, "ExitCode": 0, "ProcessConfig": { "tty": false, "entrypoint": "date", "arguments": [], "privileged": false }, "OpenStdin": false, "OpenStderr": true, "OpenStdout": true, "CanRemove": false, "ContainerID": "973bc3bb0eadf395d4896f088bfa2a21b853c3683c1fe9e58ea352235c105a6d", "DetachKeys": "EBE=", "Pid": 1146486 }
*/
async function exec(params) {
    let res1 = await dockerApi(
        params.host,
        'POST',
        `/${process.env.DOCKER_API_VERSION}/containers/${params.id}/exec`,
        params.options,
        params.timeout
    );
    if (res1.statusCode >= 300) throw new Error(`bad statusCode ${res1.statusCode} while exec`);
    res1 = JSON.parse(res1.body);
    const execId = res1.Id;

    // lance un timeout qui verifiera si le exec est trop long
    let x = null;
    if (params.timeout)
        x = setTimeout(async () => {
            let execData = null;
            try {
                execData = await getExec({
                    host: params.host,
                    id: execId,
                    timeout: params.timeout,
                });

                // le process n'a surement pas encore eu le temps de se lancer
                // la seule façon simple d'eviter ça c'est de mettre un timeout qui soit pas trop court
                if (execData.Pid == 0) throw new Error('cant kill process Pid 0');

                // kill the process
                let command = 'sh';
                let args = [`-c`, `kill ${execData.Pid}`];
                if (params.host) {
                    command = 'ssh';
                    args = [`${params.host}`, `kill ${execData.Pid}`];
                }
                const { stdout } = await execFilePromise(command, args);
                // all good. no need to do anything because the main job will return, now that its killed
            } catch (err) {
                console.log(`cant kill process ${execData ? execData.Pid : 'unknown'}`, err);
            }
        }, params.timeout * 1000);

    const res2 = await dockerApi(
        params.host,
        'POST',
        `/${process.env.DOCKER_API_VERSION}/exec/${execId}/start`,
        {},
        params.timeout,
        (line) => {
            if (params.onLine) params.onLine(line);
        },
        true
    );
    if (res2.statusCode >= 300) throw new Error(`bad ${res2.statusCode} statusCode while execstart`);

    if (x) clearTimeout(x);

    const execData = await getExec({
        host: params.host,
        id: execId,
        timeout: params.timeout,
    });

    return execData;
}

export default {
    dockerApi,
    createTunnel,
    closeTunnel,
    info,
    listTasks,
    getTask,
    listNodes,
    getNode,
    listServices,
    listContainers,
    getService,
    getContainer,
    getExec,
    getEvents,
    exec,
};
