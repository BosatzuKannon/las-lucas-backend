import type { RoomStatus, TournamentType } from '@prisma/client';

/**
 * DTOs de respuesta del Historial de Torneos (Fase 2).
 * Diseñados 1:1 para alimentar la UI del mockup: tarjeta "Resumen
 * Competitivo", tabs segmentados y tarjetas de torneo (finalizado/cancelado).
 */

/** Entrada del podio (Top 4) de un torneo finalizado. */
export interface HistoryPodiumEntry {
  position: number;
  /** @usuario (snapshot de inscripción). */
  userName: string;
  /** Puntos obtenidos por el jugador en esta sala (RoomParticipant.score). */
  score: number;
  /** Premio en Lucas ganado en esta sala (RoomParticipant.prizeWon). */
  prizeWon: number;
}

/** GET /tournaments/history/stats — Resumen Competitivo del usuario. */
export interface GetHistoryStatsDto {
  /** Veces que participó en torneos cerrados (FINISHED o CANCELLED). */
  tournamentsPlayed: number;
  /** Veces que quedó en el top 3 de un torneo FINISHED (position <= 3). */
  podiums: number;
  /** Suma total de premios ganados (Lucas) en torneos FINISHED. */
  totalWon: number;
  /** Nivel competitivo derivado de totalWon (p.ej. "Nivel Oro"). */
  tier: string;
}

/** Item de la lista global de torneos ("Todos los Torneos"). */
export interface GlobalTournamentItemDto {
  roomId: string;
  /** Título derivado del tipo de torneo (p.ej. "Torneo Diario"). */
  displayName: string;
  tournamentType: TournamentType;
  /** Solo FINISHED o CANCELLED. */
  status: RoomStatus;
  /** ISO del inicio programado (eje cronológico de la lista). */
  startDate: string;
  /** POZO TOTAL del torneo. */
  prizePool: number;
  /** Aforo (máximo de jugadores). */
  capacity: number;
  currentPlayers: number;
  /** Top 4 del podio; null si el torneo fue CANCELLED. */
  podium: HistoryPodiumEntry[] | null;
  /** true si CANCELLED → badge "100% REEMBOLSADO". */
  fullyRefunded: boolean;
  /** ID de referencia persistido del torneo cancelado. */
  referenceId: string;
}

/** GET /tournaments/history/global — últimos 20 torneos cerrados. */
export interface GetHistoryGlobalDto {
  tournaments: GlobalTournamentItemDto[];
}

/** Item del historial del usuario ("Mis Torneos"). */
export interface MyTournamentItemDto {
  roomId: string;
  displayName: string;
  tournamentType: TournamentType;
  status: RoomStatus;
  startDate: string;
  prizePool: number;
  capacity: number;
  currentPlayers: number;
  /** Posición final del usuario (null si CANCELLED, no hubo liquidación). */
  myPosition: number | null;
  /** Puntos del usuario en esta sala. */
  myScore: number;
  /** Premio ganado por el usuario en esta sala. */
  myPrizeWon: number;
  /** true si CANCELLED → badge "100% REEMBOLSADO". */
  fullyRefunded: boolean;
  referenceId: string;
}

/** GET /tournaments/history/me — historial donde participó el usuario. */
export interface GetHistoryMeDto {
  tournaments: MyTournamentItemDto[];
}