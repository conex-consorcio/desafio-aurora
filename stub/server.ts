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

app.get("/health", (_req, res) => {
  res.json({ status: "ok", versao: "2.6.0", emVoo, picoTentativas });
});

/**
 * Registra o lance. O parceiro aceita a mesma cota mais de uma vez e cria
 * DOIS lances -- ele nao faz idempotencia por voce.
 */
app.post(
  "/lances/registrar",
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

/** Esta rota NUNCA responde. Existe porque parceiros fazem isso. */
app.get("/cotas/:grupo/pendurada", (_req, _res) => {
  /* silencio */
});

app.get("/parceiros", (_req, res) => {
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
