function queue(func, delayms) {
    let active = false;
    async function xxx(...args) {
        while (active) {
            await new Promise((resolve) => setTimeout(resolve, delayms || 0));
        }

        active = true;

        const retour = await func(...args);

        active = false;

        return retour;
    }

    return xxx;
}

export default queue;
