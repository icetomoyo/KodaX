import { runAsrtWindowsNetworkBrokerProcess } from './sandbox-runtime.js';

const requestFile = process.argv[2];
if (!requestFile) throw new Error('Missing Windows ASRT network broker request file.');

process.exitCode = await runAsrtWindowsNetworkBrokerProcess(requestFile);
