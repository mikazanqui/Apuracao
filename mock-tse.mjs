// TSE de mentira, só para ensaio. Imita o endereço e o formato (EA20) dos arquivos de resultado,
// com uma "noite de apuração" acelerada. Os votos são INVENTADOS.
//
//   node mock-tse.mjs --porta 9100 --duracao 120
//
// Usado pelo coletor em `node coletor.mjs --ensaio`.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIGLA = { 11: "RO", 12: "AC", 13: "AM", 14: "RR", 15: "PA", 16: "AP", 17: "TO", 21: "MA", 22: "PI", 23: "CE", 24: "RN", 25: "PB", 26: "PE", 27: "AL", 28: "SE", 29: "BA", 31: "MG", 32: "ES", 33: "RJ", 35: "SP", 41: "PR", 42: "SC", 43: "RS", 50: "MS", 51: "MT", 52: "GO", 53: "DF" };

function h32(n) { n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) | 0; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return (n >>> 0) / 4294967296; }
const pct = (x) => (x * 100).toFixed(2).replace(".", ",");

export function iniciarMock({ porta = 9100, duracao = 120, malha, aguardar = 4, eleicao = "6258" } = {}) {
  const m = JSON.parse(fs.readFileSync(malha, "utf8"));
  const E6 = eleicao.padStart(6, "0");
  const MUN = [], porUf = {};
  const vies = { 1: 0.0, 2: 0.17, 3: -0.03, 4: -0.13, 5: -0.14 };
  for (let i = 0; i < m.c.length; i++) {
    const uf = SIGLA[m.u[i]].toLowerCase();
    const lista = porUf[uf] || (porUf[uf] = []);
    const tse = String(1000 + lista.length * 3 + 7).padStart(5, "0");
    let nome = m.n[i].toUpperCase();
    if (i % 97 === 0) nome = nome.replace(/ /g, "-");               // hífen no lugar de espaço
    else if (i % 131 === 0 && nome.length > 6) nome = nome.slice(0, 3) + nome.slice(4); // erro de digitação
    else if (i % 977 === 0) nome = "MUNICIPIO FANTASMA " + i;       // sem correspondência
    const h1 = h32(i * 3 + 1), h2 = h32(i * 3 + 2), h3 = h32(i * 3 + 3);
    let share = 0.5 + (vies[Math.floor(m.u[i] / 10)] || 0) + (h32(m.u[i] * 13 + 7) - 0.5) * 0.1 + (h1 - 0.5) * 0.22;
    share = Math.max(0.12, Math.min(0.88, share));
    const tot = Math.round(1200 + 90000 * Math.pow(h2, 5));
    const o = { i, ibge: m.c[i], uf, tse, nome, tot, share, secoes: Math.max(1, Math.round(tot / 250)), r: Math.min(0.8, 0.02 + 0.7 * h3 + 0.1 * Math.sqrt(h2)) };
    lista.push(o); MUN.push(o);
  }
  const t0 = Date.now();
  const T = () => Math.min(1.2, (Date.now() - t0) / 1000 / duracao);
  const abre = () => (Date.now() - t0) / 1000 >= aguardar;

  function estado(o, t) {
    const f = Math.max(0, Math.min(1, (t - o.r) / 0.18));
    const s = Math.max(0.05, Math.min(0.95, o.share + (h32(o.i * 11 + Math.floor(t * 60)) - 0.5) * 0.04 * (1 - f)));
    const vt = Math.round(o.tot * f);
    const outros = Math.round(vt * 0.04);
    const a = Math.round((vt - outros) * s), b = vt - outros - a;
    return { f, a, b, c: outros, vt, st: Math.round(f * o.secoes) };
  }

  function arquivo(tpabr, cdabr, lista) {
    const t = T();
    let a = 0, b = 0, c = 0, vt = 0, ts = 0, st = 0, te = 0;
    for (const o of lista) { const e = estado(o, t); a += e.a; b += e.b; c += e.c; vt += e.vt; ts += o.secoes; st += e.st; te += Math.round(o.tot * 1.25); }
    const cand = (n, nm, nmu, sg, votos, ordem) => ({ n, sqcand: String(ordem), nm, nmu, st: "", vap: String(votos), pvap: vt ? pct(votos / vt) : "0,00", pvapn: vt ? pct(votos / vt) : "0,00" });
    const grupo = (n, nm, sg, cd) => ({ n, nm, tp: "c", par: [{ n, sg, nm: "PARTIDO " + nm, cand: [cd] }] });
    const agora = new Date(Math.floor(Date.now() / 10000) * 10000);
    const hg = agora.toTimeString().slice(0, 8);
    return {
      ele: E6, t: "2", f: "o", sup: "n", tpabr, cdabr, dg: "25/10/2026", hg, idg: "1", dv: "s", dt: "25/10/2026", ht: hg, tf: "n", and: "p", md: "n", esae: "n",
      carg: [{
        cd: "0001", nmn: "Presidente", nmm: "Presidente", nmf: "Presidenta", nv: "1",
        agr: [
          grupo("13", "CANDIDATO VERMELHO", "VM", cand("13", "CANDIDATO VERMELHO (FICTICIO)", "VERMELHO", "VM", a, 1)),
          grupo("22", "CANDIDATO AZUL", "AZ", cand("22", "CANDIDATO AZUL (FICTICIO)", "AZUL", "AZ", b, 2)),
          grupo("55", "CANDIDATO CINZA", "CZ", cand("55", "CANDIDATO CINZA (FICTICIO)", "CINZA", "CZ", c, 3)),
        ],
      }],
      s: { ts: String(ts), st: String(st), snt: String(ts - st), pst: pct(ts ? st / ts : 0) },
      e: { te: String(te), est: String(Math.round(te * 0.8)), esnt: String(Math.round(te * 0.2)) },
      v: { tv: String(vt), vvc: String(vt), vb: "0", vn: "0" },
    };
  }

  function config() {
    return {
      dg: "20/10/2026", hg: "12:00:00",
      abr: Object.keys(porUf).map((uf) => ({ cd: uf, ds: uf.toUpperCase(), mu: porUf[uf].map((o) => ({ cd: o.tse, nm: o.nome, c: "n", z: ["0001"] })) })),
    };
  }

  const servidor = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const base = `/oficial/ele2026/${eleicao}`;
    const enviar = (obj) => {
      const corpo = JSON.stringify(obj), et = '"' + crypto.createHash("md5").update(corpo).digest("hex") + '"';
      if (req.headers["if-none-match"] === et) { res.writeHead(304, { etag: et }); return res.end(); }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", etag: et });
      res.end(corpo);
    };
    const nao = () => { res.writeHead(404, { "content-type": "text/plain" }); res.end("nao encontrado"); };

    if (u.pathname === `${base}/config/mun-e${E6}-cm.json`) return enviar(config());
    const r = u.pathname.match(new RegExp(`^${base}/dados/([a-z]{2})/([a-z]{2})(\\d{5})?-c0001-e${E6}-u\\.json$`));
    if (!r || !abre()) return nao();
    const [, pasta, uf, cod] = r;
    if (pasta === "br" && uf === "br" && !cod) return enviar(arquivo("br", "br", MUN));
    if (pasta !== uf || !porUf[uf]) return nao();
    if (!cod) return enviar(arquivo("uf", uf, porUf[uf]));
    const o = porUf[uf].find((x) => x.tse === cod);
    return o ? enviar(arquivo("mu", uf + cod, [o])) : nao();
  });
  servidor.listen(porta, "127.0.0.1");
  return { base: `http://127.0.0.1:${porta}/oficial/ele2026`, servidor, total: MUN.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), get = (k, d) => { const i = a.indexOf("--" + k); return i >= 0 ? a[i + 1] : d; };
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const mock = iniciarMock({ porta: +get("porta", 9100), duracao: +get("duracao", 120), malha: get("malha", path.join(aqui, "malha.json")), aguardar: +get("aguardar", 4) });
  console.log(`TSE de mentira em ${mock.base} (${mock.total} cidades). Dados inventados.`);
}
