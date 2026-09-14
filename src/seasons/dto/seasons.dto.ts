import type { SeasonStatus } from '@prisma/client';

/**
 * DTOs de respuesta de Temporadas (Fase 3: Ranking Pro Player y Liquidación
 * de Temporadas). Alimentan la vista "Ranking": countdown del endDate,
 * tarjetas de premios y tabla de jugadores Top 50.
 */

/** Información de la temporada activa + sus 3 premios en juego. */
export interface SeasonInfoDto {
  id: string;
  /** ISO del inicio de la temporada. */
  startDate: string;
  /** ISO del cierre (eje del temporizador en cuenta regresiva). */
  endDate: string;
  status: SeasonStatus;
  firstPlacePrize: number;
  secondPlacePrize: number;
  thirdPlacePrize: number;
}

/** Entrada de la tabla de jugadores (posición de competición). */
export interface SeasonRankingEntryDto {
  userId: string;
  userName: string;
  avatarUrl: string | null;
  /** Posición de competición (los empates comparten posición). */
  position: number;
  globalPoints: number;
}

/** GET /seasons/current — temporada activa + Top 50 por globalPoints. */
export interface GetSeasonCurrentDto {
  season: SeasonInfoDto;
  ranking: SeasonRankingEntryDto[];
}