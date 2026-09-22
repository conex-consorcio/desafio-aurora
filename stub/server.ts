/**
 * Aurora Consorcios - stub do parceiro.
 *
 * Nao e parte da solucao: e o mundo externo. Nao altere.
 *
 * O que ele faz de util para o desafio:
 *   - conta cada chamada recebida, por chave de negocio
 *   - tem limite de concorrencia: acima dele responde 429 com Retry-After
 *   - e lento de proposito (120ms a 900ms)
 */
import crypto from "node:crypto";
import express from "express";

const PORT = Number(process.env.PORT ?? 4010);
const LIMITE = Number(process.env.LIMITE_CONCORRENCIA ?? 20);

const app = express();
app.use(express.json({ limit: "4mb" }));

/** chave de negocio -> quantas vezes o parceiro foi chamado para ela */
const chamadas = new Map<string, number>();
let emVoo = 0;
let picoConcorrencia = 0;
/** Requisicoes simultaneas TENTADAS, incluindo as recusadas com 429. */
let tentativasEmVoo = 0;
let picoTentativas = 0;
let recusas429 = 0;

function contar(chave: string): number {
  const atual = (chamadas.get(chave) ?? 0) + 1;
  chamadas.set(chave, atual);
  return atual;
}

function dormir(ms: number) {
  return new Promise((ok) => setTimeout(ok, ms));
}

/** Limite de concorrencia do parceiro. Acima dele, 429. */
function comLimite(handler: express.RequestHandler): express.RequestHandler {
  return async (req, res, next) => {
    tentativasEmVoo += 1;
    picoTentativas = Math.max(picoTentativas, tentativasEmVoo);

    try {
      if (emVoo >= LIMITE) {
        recusas429 += 1;
        res.setHeader("Retry-After", "2");
        res.status(429).json({
          codigo: "LIMITE_EXCEDIDO",
          mensagem: `Maximo de ${LIMITE} requisicoes simultaneas.`,
        });
        return;
      }

      emVoo += 1;
      picoConcorrencia = Math.max(picoConcorrencia, emVoo);
      try {
        await handler(req, res, next);
      } finally {
        emVoo -= 1;
      }
    } finally {
      tentativasEmVoo -= 1;
    }
  };
}

// --------------------------------------------------------------------------
// Autenticacao
// --------------------------------------------------------------------------

const CLIENT_ID = "victoria-pro";
const CLIENT_SECRET = "dev-secret-nao-usar-em-producao";
const TOKEN_TTL = Number(process.env.TOKEN_TTL_SEGUNDOS ?? 300);

/** So existe UM token valido por vez. Emitir outro mata o anterior. */
let tokenVigente: string | null = null;
let tokenExpiraEm = 0;

app.post("/auth/token", async (req, res) => {
  const { clientId, clientSecret } = req.body ?? {};

  if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
    res.status(401).json({
      codigo: "NAO_AUTORIZADO",
      mensagem: "clientId ou clientSecret invalidos.",
    });
    return;
  }

  contar("auth:token");

  // Emitir token custa caro do lado da Aurora. Quem renova em manada paga
  // este preco vezes o tamanho da manada.
  await dormir(400);

  tokenVigente = crypto.randomBytes(24).toString("hex");
  tokenExpiraEm = Date.now() + TOKEN_TTL * 1000;

  res.json({ accessToken: tokenVigente, expiraEm: TOKEN_TTL });
});

function exigeToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const enviado = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");

  if (!enviado || enviado !== tokenVigente || Date.now() >= tokenExpiraEm) {
    res.status(401).json({
      codigo: "NAO_AUTORIZADO",
      mensagem: "Token ausente, expirado ou substituido por uma emissao mais nova.",
    });
    return;
  }

  next();
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", versao: "2.6.0", emVoo, picoTentativas });
});

/**
 * Registra o lance. O parceiro aceita a mesma cota mais de uma vez e cria
 * DOIS lances -- ele nao faz idempotencia por voce.
 */
app.post(
  "/lances/registrar",
  exigeToken,
  comLimite(async (req, res) => {
    const { grupo, cota, assembleia } = req.body ?? {};
    if (!grupo || !cota || !assembleia) {
      res.status(400).json({ codigo: "REQUISICAO_INVALIDA" });
      return;
    }

    await dormir(120 + Math.floor(Math.random() * 180));

    const chave = `lance:${grupo}:${cota}:${assembleia}`;
    const vez = contar(chave);

    res.json({
      protocolo: `PRT-${crypto.randomBytes(4).toString("hex")}`,
      grupo,
      cota,
      assembleia,
      // Quantas vezes ESTA cota ja foi registrada. Se vier > 1, houve duplicata.
      vezRegistrada: vez,
    });
  }),
);

/** Detalhe de uma cota. Lento. */
app.get(
  "/cotas/:grupo/:numero",
  exigeToken,
  comLimite(async (req, res) => {
    await dormir(200 + Math.floor(Math.random() * 700));
    contar(`cota:${req.params.grupo}:${req.params.numero}`);
    res.json({
      grupo: req.params.grupo,
      numero: req.params.numero,
      situacao: "DISPONIVEL",
      valorCredito: 8_990_000,
    });
  }),
);

/**
 * Detalhe do grupo. Exige token, mas NAO passa pelo limite de concorrencia --
 * e barata do lado da Aurora.
 */
app.get("/grupos/:numero", exigeToken, (req, res) => {
  contar(`grupo:${req.params.numero}`);
  res.json({
    numeroGrupo: req.params.numero,
    bem: "Automovel",
    valorCredito: 8_990_000,
    prazoMeses: 80,
  });
});

/** Esta rota NUNCA responde. Existe porque parceiros fazem isso. */
app.get("/cotas/:grupo/pendurada", (_req, _res) => {
  /* silencio */
});

app.get("/parceiros", exigeToken, (_req, res) => {
  res.json({
    codigo: "PRC-0091",
    razaoSocial: "Aurora Participacoes LTDA",
    documento: "12345678000195",
    senhaCliente: "Sup3rS3cret!2026",
    comissaoPercentual: 3.75,
  });
});

// -------- instrumentacao para os testes --------

app.get("/_admin/chamadas", (_req, res) => {
  res.json({
    chamadas: Object.fromEntries(chamadas),
    picoConcorrencia,
    picoTentativas,
    recusas429,
    limite: LIMITE,
  });
});

/** Invalida o token vigente sem esperar o TTL. Usado pelos testes. */
app.post("/_admin/expirar-token", (_req, res) => {
  tokenExpiraEm = 0;
  res.json({ ok: true });
});

app.post("/_admin/reset", (_req, res) => {
  chamadas.clear();
  picoConcorrencia = 0;
  picoTentativas = 0;
  recusas429 = 0;
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[aurora] stub em http://localhost:${PORT} (limite=${LIMITE})`);
});
