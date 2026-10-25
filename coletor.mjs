#!/usr/bin/env node
// Coletor da apuração. Um programa só, sem instalar nada (precisa do Node 18 ou mais novo).
//
//   node coletor.mjs                 apuração real do 2º turno (domingo, 25/10)
//   node coletor.mjs --turno 1       1º turno (já 100% apurado; serve para testar com dados reais)
//   node coletor.mjs --ensaio        "noite de apuração" inventada, acelerada, sem depender do TSE
//   node coletor.mjs --diag          só confere o que o TSE responde e mostra um resumo
//
// O que ele faz:
//   1. Lê os JSON públicos do TSE: Brasil, 27 UFs e um arquivo por cidade.
//   2. Liga o código de cidade do TSE ao código do IBGE (o mapa usa o do IBGE).
//   3. Serve o site (/), o desenho do mapa (/malha.json) e os números (/feed) na porta 8787.
//
// Respeita o limite do TSE (100 requisições por segundo por IP): usa no máximo ~60 por segundo,
// só rebusca cidades ainda não terminadas, e para 2 minutos se o TSE responder 403 ou 429.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

/* ---------- opções ---------- */
function lerArgs(v) {
  const o = {};
  for (let i = 0; i < v.length; i++) {
    if (!v[i].startsWith("--")) continue;
    const k = v[i].slice(2), prox = v[i + 1];
    if (prox === undefined || prox.startsWith("--")) o[k] = true; else { o[k] = prox; i++; }
  }
  return o;
}
const args = lerArgs(process.argv.slice(2));
const TURNO = String(args.turno || process.env.TURNO) === "1" ? "1" : "2";
const ELEICAO = { "1": "6257", "2": "6258" }[TURNO]; // Eleição Geral Federal 2026 (códigos do TSE)
const E6 = ELEICAO.padStart(6, "0");
const ENSAIO = !!args.ensaio || process.env.ENSAIO === "1";
const PORTA = +(args.porta || process.env.PORT || 8787);
const INTERVALO = +(args.intervalo || 15) * 1000;      // pausa entre rodadas
const REBUSCA = +(args.rebusca || 90) * 1000;          // rebusca cidades de uma UF mesmo sem mudança de carimbo
const TAXA = Math.min(90, +(args.taxa || 60));         // requisições por segundo
const CAND_A = String(args.a || "13"), CAND_B = String(args.b || "22");
const MALHA = path.join(AQUI, "malha.json");
let BASE = String(args.tse || process.env.TSE_BASE || "https://resultados.tse.jus.br/oficial/ele2026");

const UFS = ["ac", "al", "am", "ap", "ba", "ce", "df", "es", "go", "ma", "mg", "ms", "mt", "pa", "pb", "pe", "pi", "pr", "rj", "rn", "ro", "rr", "rs", "sc", "se", "sp", "to", "zz"];
const SIGLA = { 11: "ro", 12: "ac", 13: "am", 14: "rr", 15: "pa", 16: "ap", 17: "to", 21: "ma", 22: "pi", 23: "ce", 24: "rn", 25: "pb", 26: "pe", 27: "al", 28: "se", 29: "ba", 31: "mg", 32: "es", 33: "rj", 35: "sp", 41: "pr", 42: "sc", 43: "rs", 50: "ms", 51: "mt", 52: "go", 53: "df" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hora = () => new Date().toLocaleTimeString("pt-BR");
const log = (...a) => console.log(`[${hora()}]`, ...a);

/* ---------- rede, com limite de velocidade ---------- */
const LIM = { tokens: TAXA, t: Date.now() };
async function pegaToken() {
  for (;;) {
    const agora = Date.now();
    LIM.tokens = Math.min(TAXA, LIM.tokens + ((agora - LIM.t) / 1000) * TAXA); LIM.t = agora;
    if (LIM.tokens >= 1) { LIM.tokens -= 1; return; }
    await sleep(15);
  }
}
const ST = { req: 0, ok: 0, n304: 0, n404: 0, erros: 0, ultimoErro: null, pausaAte: 0 };
const etags = new Map(), guardado = new Map();

async function baixar(url, parse) {
  if (Date.now() < ST.pausaAte) return { status: 429, pausado: true };
  await pegaToken(); ST.req++;
  const h = { accept: "application/json", "user-agent": "painel-apuracao/1.0" };
  const et = etags.get(url); if (et) h["if-none-match"] = et;
  let r;
  try { r = await fetch(url, { headers: h, signal: AbortSignal.timeout(15000) }); }
  catch (e) { ST.erros++; ST.ultimoErro = String((e && e.message) || e); return { status: 0 }; }
  if (r.status === 304) { ST.n304++; return { status: 304, dado: guardado.get(url) }; }
  if (r.status === 404) { ST.n404++; return { status: 404 }; }
  if (r.status === 403 || r.status === 429) {
    ST.pausaAte = Date.now() + 120000; ST.ultimoErro = `HTTP ${r.status} do TSE. Pausa de 2 minutos.`;
    log("ATENÇÃO:", ST.ultimoErro); return { status: r.status };
  }
  if (!r.ok) { ST.erros++; ST.ultimoErro = `HTTP ${r.status} em ${url}`; return { status: r.status }; }
  let json;
  try { json = JSON.parse((await r.text()).replace(/^﻿/, "")); } catch { ST.erros++; ST.ultimoErro = "JSON inválido em " + url; return { status: 0 }; }
  const dado = parse ? parse(json) : json;
  const novo = r.headers.get("etag"); if (novo) { etags.set(url, novo); guardado.set(url, dado); }
  ST.ok++;
  return { status: 200, dado };
}
async function pool(itens, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => { while (i < itens.length) { const k = i++; await fn(itens[k], k); } }));
}

/* ---------- leitura dos arquivos do TSE (EA20) ---------- */
function num(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (!s) return 0;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return parseFloat(s.replace(/\./g, "").replace(",", ".")) || 0;
  return parseFloat(s.replace(",", ".")) || 0;
}
function todosCand(o, saida) {
  if (Array.isArray(o)) { o.forEach((x) => todosCand(x, saida)); return saida; }
  if (!o || typeof o !== "object") return saida;
  if (Array.isArray(o.cand)) o.cand.forEach((c) => c && typeof c === "object" && saida.push(c));
  for (const [k, v] of Object.entries(o)) if (k !== "cand" && v && typeof v === "object") todosCand(v, saida);
  return saida;
}
function normalizar(json) {
  const s = json.s || {}, e = json.e || {}, v = json.v || {};
  const pega = (k) => (s[k] ?? e[k] ?? v[k] ?? json[k]);
  const vistos = new Set(), candidatos = [];
  for (const c of todosCand(json, [])) {
    const chave = String(c.sqcand ?? "") + "|" + String(c.n ?? "");
    if (vistos.has(chave)) continue; vistos.add(chave);
    candidatos.push({ n: String(c.n ?? ""), nome: c.nmu ?? c.nm ?? "", votos: num(c.vap) });
  }
  const ts = num(pega("ts")), st = num(pega("st"));
  const secoesPct = pega("pst") !== undefined && pega("pst") !== "" ? num(pega("pst")) : ts ? (st / ts) * 100 : 0;
  return {
    geradoEm: json.dg && json.hg ? `${json.dg} ${json.hg}` : null,
    secoesPct, secoesTotal: ts, secoesTotalizadas: st,
    comparecimentoPct: pega("pc") !== undefined ? num(pega("pc")) : null,
    validos: candidatos.reduce((t, c) => t + c.votos, 0),
    brancos: num(pega("vb")), nulos: num(pega("tvn") ?? pega("vn")),
    candidatos,
  };
}
const votosDe = (n, id) => { const c = n.candidatos.find((x) => x.n === id); return c ? c.votos : 0; };

/* ---------- endereços ---------- */
const urlBR = () => `${BASE}/${ELEICAO}/dados/br/br-c0001-e${E6}-u.json`;
const urlUF = (uf) => `${BASE}/${ELEICAO}/dados/${uf}/${uf}-c0001-e${E6}-u.json`;
const urlMun = (m) => `${BASE}/${ELEICAO}/dados/${m.uf}/${m.uf}${m.tse}-c0001-e${E6}-u.json`;
const urlsConfig = () => (args.config ? [String(args.config)] : [
  `${BASE}/${ELEICAO}/config/mun-e${E6}-cm.json`,
  `${BASE}/comum/config/mun-e${E6}-cm.json`,
  `${BASE}/${ELEICAO}/config/mun-c${E6}-cm.json`,
]);

/* ---------- cidades: código do TSE -> código do IBGE ---------- */
const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let ant = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const at = [i]; let menor = i;
    for (let j = 1; j <= b.length; j++) { const v = Math.min(ant[j] + 1, at[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); at.push(v); if (v < menor) menor = v; }
    if (menor > max) return max + 1;
    ant = at;
  }
  return ant[b.length];
}
function extrairMunicipios(json) {
  const out = [];
  (function dfs(o, uf) {
    if (Array.isArray(o)) { o.forEach((x) => dfs(x, uf)); return; }
    if (!o || typeof o !== "object") return;
    const cd = o.cd !== undefined ? String(o.cd) : null;
    if (cd && /^[A-Za-z]{2}$/.test(cd)) uf = cd.toLowerCase();
    else if (cd && /^\d{3,5}$/.test(cd) && typeof o.nm === "string" && uf) out.push({ uf, tse: cd.padStart(5, "0"), nome: o.nm });
    for (const v of Object.values(o)) if (v && typeof v === "object") dfs(v, uf);
  })(json, null);
  return out;
}
function ligar(tse, malha) {
  const ibgePorUf = {};
  malha.c.forEach((cod, i) => { const uf = SIGLA[malha.u[i]]; (ibgePorUf[uf] ||= []).push({ ibge: cod, nome: malha.n[i], n: norm(malha.n[i]) }); });
  const usados = new Set(), ligadas = [], sem = [];
  const porUf = {};
  tse.filter((m) => m.uf !== "zz").forEach((m) => (porUf[m.uf] ||= []).push(m));
  for (const [uf, lista] of Object.entries(porUf)) {
    const ibge = ibgePorUf[uf] || [], exato = new Map();
    ibge.forEach((x) => { const a = exato.get(x.n) || []; a.push(x); exato.set(x.n, a); });
    const pendentes = [];
    for (const m of lista) {
      const c = (exato.get(norm(m.nome)) || []).filter((x) => !usados.has(x.ibge));
      if (c.length === 1) { usados.add(c[0].ibge); ligadas.push({ ibge: c[0].ibge, uf, tse: m.tse, nome: m.nome, via: "nome" }); } else pendentes.push(m);
    }
    for (const m of pendentes) {
      const n = norm(m.nome), livres = ibge.filter((x) => !usados.has(x.ibge));
      let melhor = null, empate = false, d0 = 3;
      for (const x of livres) { const d = lev(n, x.n, 2); if (d < d0) { d0 = d; melhor = x; empate = false; } else if (d === d0 && d <= 2) empate = true; }
      if (melhor && !empate && n.length >= 5) { usados.add(melhor.ibge); ligadas.push({ ibge: melhor.ibge, uf, tse: m.tse, nome: m.nome, via: "parecido" }); continue; }
      const cont = livres.filter((x) => n.length >= 6 && x.n.length >= 6 && (x.n.startsWith(n) || n.startsWith(x.n)));
      if (cont.length === 1) { usados.add(cont[0].ibge); ligadas.push({ ibge: cont[0].ibge, uf, tse: m.tse, nome: m.nome, via: "prefixo" }); continue; }
      sem.push(m);
    }
  }
  const ibgeSem = malha.c.filter((c) => !usados.has(c));
  return { ligadas, semLigacao: sem, ibgeSemLigacao: ibgeSem.map((c) => malha.n[malha.c.indexOf(c)] + " (" + c + ")") };
}

/* ---------- estado ---------- */
const malha = JSON.parse(fs.readFileSync(MALHA, "utf8"));
const E = {
  inicio: Date.now(), cidades: [], ligacao: null, configTentativas: [], configOk: false,
  mun: {}, fin: new Set(), proxima: new Map(), ufMarca: new Map(), ufUltima: new Map(), br: null, ufRes: {}, varrer: new Set(), varreduras: 0,
  feed: { ok: false, turno: TURNO, ensaio: ENSAIO, motivo: "iniciando" }, feedJson: "", feedGz: null, rodadas: 0, ultimaRodada: null,
};
function publicar(obj) {
  E.feed = obj; E.feedJson = JSON.stringify(obj); E.feedGz = zlib.gzipSync(E.feedJson, { level: 6 });
}

async function carregarConfig() {
  E.configTentativas = [];
  for (const url of urlsConfig()) {
    const r = await baixar(url);
    E.configTentativas.push({ url, status: r.status });
    if (r.status !== 200) continue;
    const lista = extrairMunicipios(r.dado);
    if (lista.length < 100) { E.configTentativas[E.configTentativas.length - 1].obs = `só ${lista.length} cidades reconhecidas`; continue; }
    E.ligacao = ligar(lista, malha);
    E.cidades = E.ligacao.ligadas;
    E.configOk = true;
    log(`Cidades: ${lista.length} no TSE, ${E.cidades.length} ligadas ao IBGE, ${E.ligacao.semLigacao.length} sem ligação.`);
    return true;
  }
  return false;
}

const montar = () => {
  if (!E.br) return;
  const ufs = {};
  for (const uf of UFS) { const u = E.ufRes[uf]; if (u) ufs[uf.toUpperCase()] = { secoesPct: u.secoesPct, candidatos: u.candidatos.map((c) => ({ n: c.n, votos: c.votos })) }; }
  const br = E.br;
  publicar({
    ok: true, turno: TURNO, ensaio: ENSAIO, atualizadoEm: new Date().toISOString(),
    brasil: { geradoEm: br.geradoEm, secoesPct: br.secoesPct, comparecimentoPct: br.comparecimentoPct, validos: br.validos, brancos: br.brancos, nulos: br.nulos, candidatos: br.candidatos.map((c) => ({ n: c.n, nome: c.nome, votos: c.votos })) },
    ufs, mun: E.mun,
    cobertura: { cidadesLigadas: E.cidades.length, comDados: Object.keys(E.mun).length, finalizadas: E.fin.size },
  });
};

// Rotina rápida: Brasil e estados (28 arquivos). Também decide quais estados precisam de nova varredura de cidades.
async function rodadaRapida() {
  const br = await baixar(urlBR(), normalizar);
  if (br.status === 404) { publicar({ ok: false, turno: TURNO, ensaio: ENSAIO, motivo: "aguardando", atualizadoEm: new Date().toISOString() }); return "aguardando o TSE publicar"; }
  if (br.status !== 200 && br.status !== 304) return `TSE respondeu ${br.status || "sem resposta"}; mantendo o último resultado`;
  E.br = br.dado;
  await pool(UFS, 8, async (uf) => { const r = await baixar(urlUF(uf), normalizar); if (r.dado) E.ufRes[uf] = r.dado; });
  if (!E.configOk && Date.now() - (E.ultimaConfig || 0) > 60000) { E.ultimaConfig = Date.now(); await carregarConfig(); }
  const agora = Date.now();
  for (const uf of UFS) {
    const u = E.ufRes[uf]; if (!u || uf === "zz" || !(u.secoesTotalizadas > 0 || u.secoesPct > 0)) continue;
    if (u.geradoEm !== E.ufMarca.get(uf) || agora - (E.ufUltima.get(uf) || 0) > REBUSCA) { E.varrer.add(uf); E.ufMarca.set(uf, u.geradoEm); E.ufUltima.set(uf, agora); }
  }
  montar();
  return `Brasil ${E.br.secoesPct.toFixed(1)}% · cidades com dados ${Object.keys(E.mun).length}/${E.cidades.length} (${E.fin.size} a 100%)`;
}

// Rotina das cidades: roda sem parar, só nos estados marcados, só nas cidades ainda não terminadas.
async function varredura() {
  for (;;) {
    if (!E.configOk || !E.br || !E.varrer.size) { await sleep(1000); continue; }
    const ufsAlvo = new Set(E.varrer); E.varrer.clear();
    const agora = Date.now(), t0 = agora;
    // cidades já contando voto são rebuscadas toda vez; as zeradas, a cada 3 varreduras
    const zerada = (m) => { const z = E.mun[m.ibge]; return !!z && z[3] === 0; };
    const alvos = E.cidades
      .filter((m) => ufsAlvo.has(m.uf) && !E.fin.has(m.ibge) && (E.proxima.get(m.ibge) || 0) <= agora && (!zerada(m) || E.varreduras % 3 === 0))
      .sort((x, y) => (zerada(x) ? 1 : 0) - (zerada(y) ? 1 : 0));
    let feitas = 0, seguidos404 = 0;
    await pool(alvos, 24, async (m) => {
      if (seguidos404 > 40 || Date.now() < ST.pausaAte) return;
      const r = await baixar(urlMun(m), normalizar);
      feitas++;
      if (r.status === 404) { seguidos404++; E.proxima.set(m.ibge, Date.now() + 60000); return; }
      if (!r.dado) return;
      seguidos404 = 0;
      const n = r.dado;
      E.mun[m.ibge] = [votosDe(n, CAND_A), votosDe(n, CAND_B), n.validos, +n.secoesPct.toFixed(2)];
      if (n.secoesPct >= 99.995) E.fin.add(m.ibge);
      if (feitas % 400 === 0) montar();
    });
    E.varreduras++; montar();
    if (feitas) log(`Cidades: ${feitas} buscadas em ${((Date.now() - t0) / 1000).toFixed(1)}s · com dados ${Object.keys(E.mun).length}/${E.cidades.length} (${E.fin.size} a 100%) · req ${ST.req} (404: ${ST.n404}, erros: ${ST.erros})`);
    await sleep(300);
  }
}

async function laco() {
  varredura().catch((e) => { ST.ultimoErro = String((e && e.stack) || e); log("erro na varredura:", ST.ultimoErro.split("\n")[0]); });
  for (;;) {
    const t0 = Date.now();
    try { const msg = await rodadaRapida(); E.rodadas++; E.ultimaRodada = new Date().toISOString(); log(msg, `· ${((Date.now() - t0) / 1000).toFixed(1)}s`); }
    catch (e) { ST.erros++; ST.ultimoErro = String((e && e.stack) || e); log("erro na rodada:", ST.ultimoErro.split("\n")[0]); }
    await sleep(INTERVALO);
  }
}

/* ---------- servidor ---------- */
const RESET = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>';
function pagina() {
  const f = path.join(AQUI, "index.html");
  const h = fs.readFileSync(f, "utf8").replace('FEED_URL: ""', 'FEED_URL: "/feed"');
  return RESET + h + "</body></html>";
}
const malhaTxt = fs.readFileSync(MALHA), malhaGz = zlib.gzipSync(malhaTxt, { level: 9 });
function responder(req, res, status, tipo, corpo, extra = {}) {
  const aceita = String(req.headers["accept-encoding"] || "");
  const h = { "content-type": tipo, "access-control-allow-origin": "*", ...extra };
  if (typeof corpo === "string") corpo = Buffer.from(corpo);
  if (aceita.includes("gzip") && corpo.length > 1024 && !extra["content-encoding"]) { corpo = zlib.gzipSync(corpo); h["content-encoding"] = "gzip"; }
  h["content-length"] = corpo.length; h.vary = "accept-encoding";
  res.writeHead(status, h); res.end(corpo);
}
function diag() {
  const l = E.ligacao;
  return {
    turno: TURNO, ensaio: ENSAIO, base: BASE, eleicao: ELEICAO, iniciouEm: new Date(E.inicio).toISOString(), rodadas: E.rodadas, ultimaRodada: E.ultimaRodada,
    requisicoes: { ...ST, pausaAte: ST.pausaAte > Date.now() ? new Date(ST.pausaAte).toISOString() : null },
    config: { ok: E.configOk, tentativas: E.configTentativas },
    cidades: { ligadas: E.cidades.length, comDados: Object.keys(E.mun).length, finalizadas: E.fin.size, porNome: E.cidades.filter((c) => c.via === "nome").length, porSemelhanca: E.cidades.filter((c) => c.via !== "nome").length },
    semLigacaoNoTSE: l ? l.semLigacao.slice(0, 60) : [], semLigacaoNoIBGE: l ? l.ibgeSemLigacao.slice(0, 60) : [],
    exemploLigadasPorSemelhanca: E.cidades.filter((c) => c.via !== "nome").slice(0, 25),
  };
}
const servidor = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  try {
    if (p === "/feed") {
      const aceita = String(req.headers["accept-encoding"] || "").includes("gzip");
      const h = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=10", vary: "accept-encoding" };
      if (aceita && E.feedGz) { h["content-encoding"] = "gzip"; h["content-length"] = E.feedGz.length; res.writeHead(200, h); return res.end(E.feedGz); }
      const corpo = Buffer.from(E.feedJson || JSON.stringify(E.feed)); h["content-length"] = corpo.length; res.writeHead(200, h); return res.end(corpo);
    }
    if (p === "/" || p === "/index.html") return responder(req, res, 200, "text/html; charset=utf-8", pagina(), { "cache-control": "no-cache" });
    if (p === "/malha.json") {
      const aceita = String(req.headers["accept-encoding"] || "").includes("gzip");
      const h = { "content-type": "application/json", "cache-control": "public, max-age=86400", "access-control-allow-origin": "*", vary: "accept-encoding" };
      if (aceita) { h["content-encoding"] = "gzip"; h["content-length"] = malhaGz.length; res.writeHead(200, h); return res.end(malhaGz); }
      h["content-length"] = malhaTxt.length; res.writeHead(200, h); return res.end(malhaTxt);
    }
    if (p === "/diag") return responder(req, res, 200, "application/json; charset=utf-8", JSON.stringify(diag(), null, 2), { "cache-control": "no-store" });
    if (p === "/saude") return responder(req, res, 200, "text/plain", "ok");
    responder(req, res, 404, "text/plain", "nao encontrado");
  } catch (e) { responder(req, res, 500, "text/plain", "erro interno"); }
});

/* ---------- início ---------- */
async function principal() {
  if (ENSAIO) {
    const { iniciarMock } = await import("./mock-tse.mjs");
    const mock = iniciarMock({ porta: +(args.portamock || 9100), duracao: +(args.duracao || 180), malha: MALHA, eleicao: ELEICAO });
    BASE = mock.base;
    log(`ENSAIO: TSE de mentira em ${BASE}. Os votos são inventados e o site avisa isso na tela.`);
  }
  if (args.diag) {
    const br = await baixar(urlBR(), normalizar);
    console.log("Brasil:", urlBR(), "->", br.status, br.dado ? `${br.dado.candidatos.length} candidatos, ${br.dado.secoesPct}% das seções` : "");
    for (const uf of ["sp", "mg", "rs"]) { const r = await baixar(urlUF(uf), normalizar); console.log(uf.toUpperCase() + ":", urlUF(uf), "->", r.status); }
    const ok = await carregarConfig();
    console.log("Config de cidades:", JSON.stringify(E.configTentativas, null, 1));
    if (ok) {
      console.log("Cidades ligadas:", E.cidades.length, "| sem ligação:", E.ligacao.semLigacao.length);
      const m = E.cidades[0]; const r = await baixar(urlMun(m), normalizar); console.log("Exemplo:", urlMun(m), "->", r.status, r.dado ? JSON.stringify(r.dado.candidatos.slice(0, 3)) : "");
    }
    process.exit(0);
  }
  servidor.listen(PORTA, () => {
    log(`Site no ar: http://localhost:${PORTA}   (conferência: http://localhost:${PORTA}/diag)`);
    log(`Turno ${TURNO} · eleição ${ELEICAO} · limite de ${TAXA} requisições por segundo ao TSE`);
  });
  await carregarConfig();
  laco();
}
principal();
