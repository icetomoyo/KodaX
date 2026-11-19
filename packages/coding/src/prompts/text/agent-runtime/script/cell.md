<!-- @key t12.agent-runtime/script/cell.0 lead="\n    " -->
const { workerData } = require('node:worker_threads');
    (async () => {
      const entry = workerData.loaderUrl
        ? await (await import(workerData.loaderUrl)).tsImport(workerData.workerUrl, workerData.workerUrl)
        : await import(workerData.workerUrl);
      await entry.scriptWorkerMain();
    })().catch(error => { throw error; });
