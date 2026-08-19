const formatter = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });

export function centsToEuros(cents: number): string {
  return formatter.format(cents / 100);
}
