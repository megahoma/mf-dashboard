import { terms } from "./terms.ts";

export type DashboardTerms = { -readonly [K in keyof typeof terms]: string };

export function selectTerms(
  language: string,
  translate: (message: string) => string,
  russian: Readonly<Record<string, string>>,
): DashboardTerms {
  const apply =
    language === "en"
      ? (message: string) => message
      : language === "ru"
        ? (message: string) => russian[message] ?? message
        : translate;
  const selected = {} as DashboardTerms;
  for (const key of Object.keys(terms) as (keyof typeof terms)[]) {
    selected[key] = apply(terms[key]);
  }
  return selected;
}
