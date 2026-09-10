import https from "node:https";
import { readFileSync } from "node:fs";

const [keyPath, certPath, port] = process.argv.slice(2);
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synara browser fixture</title>
<style>body{margin:0;background:#fafafa;color:#151515;font:18px sans-serif}header{padding:24px;background:#2158ad;color:white}main{padding:24px}button{padding:16px;background:#dfb743;color:#151515;border:0}.scroll{height:900px;background:linear-gradient(#e0eee7,#284f3c)}</style></head>
<body><header><h1>Synara browser fixture</h1></header><main><p id="bridge"></p><button id="count" onclick="this.textContent='Clicked'">Click me</button><p><a href="/browser-fixture?next=1">Next page</a></p></main><div class="scroll">Scroll the guest page</div>
<script>document.querySelector('#bridge').textContent=typeof Capacitor==='undefined'?'No native bridge in this page':'Unexpected native bridge';</script></body></html>`;
const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (request, response) => {
  if (!request.url?.startsWith("/browser-fixture")) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(html);
});
server.listen(Number(port), "0.0.0.0", () => console.log(`Browser fixture listening on ${port}`));
process.on("SIGTERM", () => server.close());
