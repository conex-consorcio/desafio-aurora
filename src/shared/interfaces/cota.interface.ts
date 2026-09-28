/**
 * Shape CRU do parceiro, exatamente como chega da API da Aurora.
 * Todos os campos opcionais pois dado externo e nao-confiavel.
 * Ver ADR-0001 e ADR-0002.
 */
export interface ICotaCrua {
	grupo?: string | null;
	numero?: string | null;
	situacao?: string | null;
	valorCredito?: number | null;
}

/**
 * Modelo de visao da aplicacao para Cota. O formato externo da Aurora nao vaza daqui.
 */
export interface ICota {
	grupo: string;
	numero: string;
	situacao: string;
	valorCredito?: number;
}
