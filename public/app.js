const sidebar = document.querySelector("#sidebar");
const menuButton = document.querySelector("[data-sidebar-toggle]");
const backdrop = document.querySelector("[data-sidebar-close]");

function setSidebar(open) {
  document.body.classList.toggle("sidebar-open", open);
  menuButton?.setAttribute("aria-expanded", String(open));
}

menuButton?.addEventListener("click", () => setSidebar(!document.body.classList.contains("sidebar-open")));
backdrop?.addEventListener("click", () => setSidebar(false));
document.querySelector("[data-flash-close]")?.addEventListener("click", (event) => event.currentTarget.closest(".flash")?.remove());

const globalTicketSearch = document.querySelector(".global-search input");
document.addEventListener("keydown", (event) => {
  const isTyping = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (event.key === "/" && !isTyping && globalTicketSearch) {
    event.preventDefault();
    globalTicketSearch.focus();
  }
  if (event.key === "Escape" && document.activeElement === globalTicketSearch) globalTicketSearch.blur();
});

document.querySelector("[data-response-template]")?.addEventListener("change", (event) => {
  const target = document.querySelector("[data-response-target]");
  const template = event.currentTarget.selectedOptions[0]?.dataset.templateContent;
  if (target && template) target.value = event.currentTarget.selectedOptions[0]?.textContent.trim().startsWith("Signatur") && target.value.trim()
    ? `${target.value.trimEnd()}\n\n${template}`
    : template;
});

function filterOwnedOptions(select, ownerId, dataKey) {
  if (!select) return 0;
  let visible = 0;
  for (const option of Array.from(select.options).slice(1)) {
    const matches = Boolean(ownerId) && option.dataset[dataKey] === String(ownerId);
    option.hidden = !matches;
    option.disabled = !matches;
    if (matches) visible += 1;
  }
  if (select.selectedOptions[0]?.disabled) select.value = "";
  return visible;
}

const customerSelect = document.querySelector("[data-customer-select]");
const contactSelect = document.querySelector("[data-contact-select]");
if (customerSelect && contactSelect) {
  const updateContacts = () => filterOwnedOptions(contactSelect, customerSelect.value, "customerId");
  customerSelect.addEventListener("change", updateContacts);
  updateContacts();
}

const requesterSelect = document.querySelector("[data-ticket-requester]");
const ticketAssetSelect = document.querySelector("[data-ticket-asset]");
const assetHelp = document.querySelector("[data-asset-help]");
if (ticketAssetSelect) {
  const updateTicketAssets = () => {
    const requesterId = requesterSelect?.value || ticketAssetSelect.dataset.defaultRequester;
    const count = filterOwnedOptions(ticketAssetSelect, requesterId, "ownerId");
    if (assetHelp) assetHelp.textContent = count
      ? `${count} zugeordnete ${count === 1 ? "Ressource" : "Ressourcen"} verfügbar.`
      : "Dieser Person sind noch keine aktiven Ressourcen zugeordnet.";
  };
  requesterSelect?.addEventListener("change", updateTicketAssets);
  updateTicketAssets();
}

const queueSelect = document.querySelector("[data-queue-select]");
const slaSelect = document.querySelector("[data-sla-select]");
if (queueSelect && slaSelect) {
  queueSelect.addEventListener("change", () => {
    const defaultSla = queueSelect.selectedOptions[0]?.dataset.defaultSla;
    if (defaultSla && Array.from(slaSelect.options).some((option) => option.value === defaultSla)) {
      slaSelect.value = defaultSla;
    }
  });
}

for (const autocomplete of document.querySelectorAll("[data-address-autocomplete]")) {
  const form = autocomplete.closest("form");
  const addressInput = autocomplete.querySelector("[data-address-input]");
  const cityInput = form?.querySelector("[data-city-input]");
  const latitudeInput = autocomplete.querySelector("[data-latitude-input]");
  const longitudeInput = autocomplete.querySelector("[data-longitude-input]");
  const results = autocomplete.querySelector("[data-address-results]");
  let timer;
  let requestController;

  const closeResults = () => {
    results.hidden = true;
    results.replaceChildren();
  };

  const showMessage = (message) => {
    const status = document.createElement("div");
    status.className = "address-suggestion-status";
    status.textContent = message;
    results.replaceChildren(status);
    results.hidden = false;
  };

  const chooseSuggestion = (suggestion) => {
    addressInput.value = suggestion.address || suggestion.label;
    if (cityInput && suggestion.city) cityInput.value = suggestion.city;
    latitudeInput.value = String(suggestion.latitude);
    longitudeInput.value = String(suggestion.longitude);
    closeResults();
  };

  const renderSuggestions = (suggestions) => {
    if (!suggestions.length) return showMessage("Keine passende Adresse gefunden. Manuelle Eingabe ist weiterhin möglich.");
    const fragment = document.createDocumentFragment();
    for (const suggestion of suggestions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "address-suggestion";
      button.setAttribute("role", "option");
      const label = document.createElement("strong");
      label.textContent = suggestion.address || suggestion.label;
      const detail = document.createElement("span");
      detail.textContent = [suggestion.postcode, suggestion.city, suggestion.country].filter(Boolean).join(" · ");
      button.append(label, detail);
      button.addEventListener("click", () => chooseSuggestion(suggestion));
      fragment.append(button);
    }
    results.replaceChildren(fragment);
    results.hidden = false;
  };

  const search = async () => {
    const query = [addressInput.value.trim(), cityInput?.value.trim()].filter(Boolean).join(", ");
    if (query.length < 3) return closeResults();
    requestController?.abort();
    requestController = new AbortController();
    showMessage("Adressen werden gesucht …");
    try {
      const response = await fetch(`/customers/address-search?q=${encodeURIComponent(query)}`, {
        headers: { Accept: "application/json" },
        signal: requestController.signal
      });
      if (!response.ok) throw new Error("Adresssuche nicht erreichbar");
      const payload = await response.json();
      renderSuggestions(payload.suggestions || []);
    } catch (error) {
      if (error.name !== "AbortError") showMessage("Adresssuche derzeit nicht erreichbar. Du kannst die Adresse manuell speichern.");
    }
  };

  addressInput?.addEventListener("input", () => {
    latitudeInput.value = "";
    longitudeInput.value = "";
    window.clearTimeout(timer);
    timer = window.setTimeout(search, 350);
  });
  cityInput?.addEventListener("input", () => {
    latitudeInput.value = "";
    longitudeInput.value = "";
    window.clearTimeout(timer);
    if (addressInput.value.trim().length >= 3) timer = window.setTimeout(search, 350);
  });
  addressInput?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeResults();
  });
  document.addEventListener("click", (event) => {
    if (!autocomplete.contains(event.target)) closeResults();
  });
}

for (const mapElement of document.querySelectorAll("[data-customer-map]")) {
  if (!globalThis.L) continue;
  let locations = [];
  try {
    locations = JSON.parse(mapElement.dataset.locations || "[]");
  } catch {
    locations = [];
  }
  const map = globalThis.L.map(mapElement, { scrollWheelZoom: false });
  globalThis.L.tileLayer(mapElement.dataset.tileUrl, {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap-Mitwirkende</a>',
    maxZoom: 19
  }).addTo(map);
  const bounds = [];
  for (const location of locations) {
    const point = [Number(location.latitude), Number(location.longitude)];
    if (!point.every(Number.isFinite)) continue;
    const marker = globalThis.L.marker(point, {
      icon: globalThis.L.divIcon({ className: "statistics-map-marker", html: "<span></span>", iconSize: [24, 30], iconAnchor: [12, 29] })
    }).addTo(map);
    const popup = document.createElement("div");
    popup.className = "statistics-map-popup";
    const link = document.createElement("a");
    link.href = `/customers/${location.id}`;
    link.textContent = location.name;
    const address = document.createElement("span");
    address.textContent = [location.address, location.city].filter(Boolean).join(", ") || "Keine Adresse";
    const details = document.createElement("small");
    details.textContent = `${location.assets} Ressourcen · ${location.openTickets} offene Tickets`;
    popup.append(link, address, details);
    marker.bindPopup(popup);
    bounds.push(point);
  }
  if (bounds.length === 1) map.setView(bounds[0], 12);
  else if (bounds.length > 1) map.fitBounds(bounds, { padding: [35, 35], maxZoom: 12 });
  else map.setView([51.1657, 10.4515], 6);
  window.setTimeout(() => map.invalidateSize(), 0);
}

for (const form of document.querySelectorAll(".mail-channel-form")) {
  const modeInputs = [...form.querySelectorAll('input[name="connection_mode"]')];
  const inboundSelect = form.querySelector("[data-mail-inbound-select]");
  const outboundSelect = form.querySelector("[data-mail-outbound-select]");
  const serverFields = form.querySelector("[data-mail-server]");
  const graphFields = [...form.querySelectorAll("[data-mail-graph]")];
  const inboundFields = [...form.querySelectorAll("[data-mail-inbound-fields]")];
  const outboundFields = [...form.querySelectorAll("[data-mail-outbound-fields]")];
  const customFields = [...form.querySelectorAll("[data-mail-custom]")];
  const credentialHelp = form.querySelector("[data-mail-credential-help]");
  const updateMailFields = () => {
    const mode = modeInputs.find((input) => input.checked)?.value || "custom";
    const customInbound = inboundSelect?.value || "none";
    const customOutbound = outboundSelect?.value || "none";
    const usesGraph = mode === "graph" || (mode === "custom" && (customInbound === "graph" || customOutbound === "graph"));
    const usesInboundServer = ["imap_smtp", "pop3_smtp"].includes(mode) || (mode === "custom" && ["imap", "pop3"].includes(customInbound));
    const usesOutboundServer = ["imap_smtp", "pop3_smtp", "smtp_only"].includes(mode) || (mode === "custom" && customOutbound === "smtp");
    if (serverFields) serverFields.hidden = !usesInboundServer && !usesOutboundServer;
    for (const field of graphFields) field.hidden = !usesGraph;
    for (const field of inboundFields) field.hidden = !usesInboundServer;
    for (const field of outboundFields) field.hidden = !usesOutboundServer;
    for (const field of customFields) field.hidden = mode !== "custom";
    if (credentialHelp) credentialHelp.textContent = usesGraph
      ? "App-Daten der Microsoft-365-Registrierung"
      : "Server und ein Postfach-Passwort genügen meistens";
  };
  for (const input of modeInputs) input.addEventListener("change", updateMailFields);
  inboundSelect?.addEventListener("change", updateMailFields);
  outboundSelect?.addEventListener("change", updateMailFields);
  updateMailFields();
}

for (const form of document.querySelectorAll("[data-logo-form]")) {
  const fileInput = form.querySelector("[data-logo-file]");
  const encodedInput = form.querySelector("[data-logo-data]");
  const status = form.querySelector("[data-logo-status]");
  const submit = form.querySelector("[data-logo-submit]");
  const preview = form.closest(".brand-logo-panel")?.querySelector(".brand-logo-preview img");
  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    encodedInput.value = "";
    submit.disabled = true;
    if (!file) {
      status.textContent = "Keine Datei ausgewählt";
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 1_500_000) {
      status.textContent = "Bitte PNG, JPG oder WebP bis 1,5 MB wählen.";
      fileInput.value = "";
      return;
    }
    status.textContent = "Logo wird vorbereitet …";
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      encodedInput.value = String(reader.result || "");
      status.textContent = `${file.name} · ${Math.ceil(file.size / 1024)} KB`;
      submit.disabled = false;
      if (preview) preview.src = encodedInput.value;
    });
    reader.addEventListener("error", () => { status.textContent = "Datei konnte nicht gelesen werden."; });
    reader.readAsDataURL(file);
  });
}
