import { terms } from "../config/terms.ts";

export type DashboardTerms = { -readonly [K in keyof typeof terms]: string };
