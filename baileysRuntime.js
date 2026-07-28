function createBaileysLoader(importModule = () => import('baileys')) {
    let runtimePromise = null;

    return function loadBaileysRuntime() {
        if (!runtimePromise) {
            runtimePromise = Promise.resolve()
                .then(importModule)
                .catch((error) => {
                    runtimePromise = null;
                    throw new Error('Unable to load Baileys v7 runtime', {
                        cause: error,
                    });
                });
        }
        return runtimePromise;
    };
}

const loadBaileys = createBaileysLoader();

module.exports = {
    createBaileysLoader,
    loadBaileys,
};
