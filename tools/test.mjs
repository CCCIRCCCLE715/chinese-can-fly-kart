import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd=fileURLToPath(new URL('..',import.meta.url));
const files=readdirSync(new URL('../tests/',import.meta.url)).filter(x=>x.endsWith('.test.mjs')&&x!=='link.test.mjs').sort().map(x=>`tests/${x}`);
const result=spawnSync(process.execPath,['--test',...files],{cwd,stdio:'inherit'});
process.exit(result.status??1);
