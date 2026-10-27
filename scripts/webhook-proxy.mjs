// Public tunnels reach only the Photon webhook; everything else (eve's localDev session API) is refused.
import http from "node:http";
const [listen, target] = [Number(process.argv[2]), Number(process.argv[3])];
http.createServer((req, res) => {
  if (req.method !== "POST" || req.url?.split("?")[0] !== "/eve/v1/photon") {
    res.writeHead(404).end();
    return;
  }
  const up = http.request({ host: "127.0.0.1", port: target, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => res.writeHead(502).end());
  req.pipe(up);
}).listen(listen, "127.0.0.1", () => console.log(`webhook proxy ${listen} -> ${target}`));
