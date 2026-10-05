import {defineConfig} from 'vite';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
export default defineConfig({server:{host:'127.0.0.1',port:18767,strictPort:true},plugins:[{
 name:'local-audio-bake',configureServer(server){
  server.middlewares.use('/__audio-bake',async(req,res)=>{
   if(req.method!=='POST'||!/^\/(menu|race|finale)$/.test(req.url)){res.statusCode=400;res.end();return;}
   const chunks=[];let size=0;
   for await(const c of req){size+=c.length;if(size>10_000_000){res.statusCode=413;res.end();return;}chunks.push(c);}
   const data=Buffer.concat(chunks);
   if(data.toString('ascii',0,4)!=='RIFF'){res.statusCode=400;res.end();return;}
   mkdirSync(resolve('public/audio'),{recursive:true});
   writeFileSync(resolve('public/audio',req.url.slice(1)+'.wav'),data);
   res.end('saved');
  });
 }
}]});
