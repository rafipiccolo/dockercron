import delay from './lib/delay.js';

// var active = false;
// async function createTunnelSafe() {
//     while (active) {
//         await delay(1000);
//     }

//     active = true;

//     await createTunnel();

//     active = false;
// }

function queue(func, delayms) {
    let active = false;
    async function xxx() {
        while (active) {
            await delay(delayms || 0);
        }

        active = true;

        await func();

        active = false;
    }

    return xxx;
}

const createTunnelSafe = queue(createTunnel);

async function createTunnel() {
    console.log('creating');
    await delay(2000);
    console.log('created');
}

createTunnelSafe();
createTunnelSafe();
createTunnelSafe();
