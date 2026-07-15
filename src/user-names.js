function clean(value, maxLength = 80) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function userName(firstName, lastName) {
  return [clean(firstName), clean(lastName)].filter(Boolean).join(" ").slice(0, 120);
}

export function validUserNames(firstName, lastName) {
  return clean(firstName).length >= 2 && clean(lastName).length >= 2;
}

export function splitUserName(value) {
  const parts = clean(value, 120).split(" ").filter(Boolean);
  if (parts.length >= 2) return { firstName: parts.shift().slice(0, 80), lastName: parts.join(" ").slice(0, 80) };
  return parts.length === 1
    ? { firstName: "System", lastName: parts[0].slice(0, 80) }
    : { firstName: "Unbekannt", lastName: "Konto" };
}

export function userNamesFromBody(body) {
  const legacyName = clean(body.name, 120);
  const legacy = legacyName ? splitUserName(legacyName) : { firstName: "", lastName: "" };
  const firstName = clean(body.first_name) || legacy.firstName;
  const lastName = clean(body.last_name) || legacy.lastName;
  return { firstName, lastName, name: userName(firstName, lastName) };
}
