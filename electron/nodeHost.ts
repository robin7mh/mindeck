// The entry of Mindeck's utility processes (main/lib/nodeProcess.ts): runs the Node program its arguments name.
import { runNode } from './main/lib/nodeHost'

runNode(process.parentPort, process.argv.slice(2))
