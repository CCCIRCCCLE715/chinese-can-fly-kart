import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const dir=resolve(process.env.KART_CERT_DIR || fileURLToPath(new URL('../.local/certs',import.meta.url)));
const entries=Object.entries(networkInterfaces()).filter(([name])=>! /^(utun|tun|tap|docker|veth|br-)/.test(name));
const preferred=entries.filter(([name])=>/^(en\d+|eth\d+|wlan\d+|wl)/.test(name));
const addresses=[...preferred,...entries].flatMap(([,list])=>list.filter(x=>x.family==='IPv4'&&!x.internal).map(x=>x.address));
const ip=process.env.KART_LAN_IP || addresses[0];
if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error('未找到 Wi-Fi 地址，请连接 Wi-Fi 后再启动。');
mkdirSync(dir,{recursive:true,mode:0o700});
const run=args=>execFileSync('openssl',args,{stdio:'pipe'});
if (!existsSync(join(dir,'ca.key'))) {
 run(['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','365','-keyout',join(dir,'ca.key'),'-out',join(dir,'ca.pem'),'-subj','/CN=Kart Royale Local Controller CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
 run(['x509','-in',join(dir,'ca.pem'),'-outform','DER','-out',join(dir,'kart-controller.cer')]);
}
let leafValid=false;try{run(['x509','-in',join(dir,'server.pem'),'-checkend','86400','-noout']);leafValid=true;}catch{}
if (!leafValid || !existsSync(join(dir,'ip.txt')) || readFileSync(join(dir,'ip.txt'),'utf8').trim()!==ip) {
 writeFileSync(join(dir,'server.ext'),`basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:${ip}\n`);
 run(['req','-new','-newkey','rsa:2048','-nodes','-keyout',join(dir,'server.key'),'-out',join(dir,'server.csr'),'-subj','/CN=Kart Royale Local Controller']);
 run(['x509','-req','-in',join(dir,'server.csr'),'-CA',join(dir,'ca.pem'),'-CAkey',join(dir,'ca.key'),'-CAcreateserial','-out',join(dir,'server.pem'),'-days','90','-sha256','-extfile',join(dir,'server.ext')]);
 writeFileSync(join(dir,'ip.txt'),ip);
}
const payload=readFileSync(join(dir,'kart-controller.cer')).toString('base64');
writeFileSync(join(dir,'kart-controller.mobileconfig'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>PayloadType</key><string>Configuration</string><key>PayloadVersion</key><integer>1</integer><key>PayloadIdentifier</key><string>local.kart.controller</string><key>PayloadUUID</key><string>${randomUUID()}</string><key>PayloadDisplayName</key><string>赛车体感手柄</string><key>PayloadDescription</key><string>仅安装本地赛车连接证书，不包含设备管理、网络或代理设置。可随时移除此描述文件。</string><key>PayloadContent</key><array><dict><key>PayloadType</key><string>com.apple.security.root</string><key>PayloadVersion</key><integer>1</integer><key>PayloadIdentifier</key><string>local.kart.controller.ca</string><key>PayloadUUID</key><string>${randomUUID()}</string><key>PayloadDisplayName</key><string>Kart Royale Local Controller CA</string><key>PayloadCertificateFileName</key><string>kart-controller.cer</string><key>PayloadContent</key><data>${payload}</data></dict></array></dict></plist>`);
console.log(JSON.stringify({ip,certDir:dir}));
