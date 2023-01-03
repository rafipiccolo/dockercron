import assert from 'assert';
import delay from './delay.js';

describe('delay.js', () => {
    it('should wait 1 sec', async () => {
        const before = Date.now();
        await delay(1000);
        const after = Date.now();

        assert(after - before > 1000 && after - before < 1100);
    });
});
