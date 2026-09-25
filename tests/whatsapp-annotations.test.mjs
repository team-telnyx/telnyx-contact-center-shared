import { test } from "node:test";
import assert from "node:assert/strict";
import { staticMapLayout, lngLatToTile, mapLink, googleMapsLink, googleMapsEmbedUrl, googleMapsApiKey, parseLatitude, parseLongitude, mapTileTemplate } from "../lib/contact-center/maps.mjs";
import { geocodeSearch, normalizeGeocodeResult, clearGeocodeCache, geocoderUserAgent } from "../lib/contact-center/geocoding.mjs";
import { foldWhatsAppAnnotations } from "../lib/whatsapp/annotations.mjs";
import { normalizeWhatsAppDeviceContacts, normalizeWhatsAppLocation, buildWhatsAppLocationMessage, whatsappContactCard, summarizeWhatsAppContacts, buildWhatsAppContactsMessage, buildWhatsAppReactionMessage, describeWhatsAppContent, WHATSAPP_MAX_CONTACTS } from "../lib/whatsapp/policy.mjs";

test("map tiles: projection matches the XYZ convention and the mosaic covers the viewport around the pin", () => {
  assert.deepEqual([Math.floor(lngLatToTile(0, 0, 1).x), Math.floor(lngLatToTile(0, 0, 1).y)], [1, 1]);
  // Cross-check with the asinh form of the Mercator projection.
  const warsaw = lngLatToTile(21.01, 52.23, 15);
  const expectedY = Math.floor((1 - Math.asinh(Math.tan(52.23 * Math.PI / 180)) / Math.PI) / 2 * 2 ** 15);
  assert.deepEqual([Math.floor(warsaw.x), Math.floor(warsaw.y)], [18296, expectedY]);
  assert.equal(expectedY, 10789);
  const layout = staticMapLayout({ latitude: "52.23", longitude: "21.01", zoom: 15, width: 280, height: 150 });
  assert.deepEqual(layout.pin, { left: 140, top: 75 });
  assert.ok(layout.tiles.length >= 2 && layout.tiles.length <= 6, `expected a small mosaic, got ${layout.tiles.length}`);
  for (const tile of layout.tiles) {
    assert.match(tile.url, /^https:\/\/tile\.openstreetmap\.org\/15\/\d+\/\d+\.png$/);
    assert.ok(tile.left < 280 && tile.left + 256 > 0 && tile.top < 150 && tile.top + 256 > 0, "every tile overlaps the viewport");
  }
  // The pin's tile contains the projected point at the pin's pixel position.
  const centre = layout.tiles.find((tile) => tile.left <= 140 && tile.left + 256 > 140 && tile.top <= 75 && tile.top + 256 > 75);
  assert.equal(centre.key, "15/18296/10789");
  assert.equal(staticMapLayout({ latitude: 0, longitude: 179.99, zoom: 2, width: 600, height: 100 }).tiles.every((tile) => /^2\/[0-3]\/[0-3]$/.test(tile.key)), true, "tiles wrap at the antimeridian");
  assert.equal(mapTileTemplate({ NEXT_PUBLIC_MAP_TILE_URL: "https://tiles.example.com/{z}/{x}/{y}.png" }), "https://tiles.example.com/{z}/{x}/{y}.png");
  assert.equal(mapTileTemplate({ NEXT_PUBLIC_MAP_TILE_URL: "http://insecure/{z}/{x}/{y}.png" }), "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  assert.equal(mapLink({ latitude: 52.23, longitude: 21.01 }), "https://www.openstreetmap.org/?mlat=52.23&mlon=21.01#map=16/52.23/21.01");
  assert.equal(googleMapsLink({ latitude: "52.23", longitude: "21.01" }), "https://www.google.com/maps?q=52.23%2C21.01");
  assert.equal(googleMapsEmbedUrl({ latitude: "52.23", longitude: "21.01" }), "https://maps.google.com/maps?q=52.23%2C21.01&z=15&output=embed");
  assert.equal(googleMapsEmbedUrl({ latitude: 52.23, longitude: 21.01, zoom: 17, apiKey: "k 1" }), "https://www.google.com/maps/embed/v1/place?key=k%201&q=52.23%2C21.01&zoom=17");
  // The key is configured as GOOGLE_MAPS_KEY and republished for the browser.
  assert.equal(googleMapsApiKey({ GOOGLE_MAPS_KEY: " server-key " }), "server-key");
  assert.equal(googleMapsApiKey({ NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: "public-key", GOOGLE_MAPS_KEY: "server-key" }), "public-key");
  assert.equal(googleMapsApiKey({}), "");
  assert.equal(googleMapsEmbedUrl({ latitude: 52.23, longitude: 21.01, apiKey: googleMapsApiKey({}) }), "https://maps.google.com/maps?q=52.23%2C21.01&z=15&output=embed");
  assert.throws(() => parseLatitude("91"), /Latitude/);
  assert.throws(() => parseLongitude("abc"), /Longitude/);
});

test("geocoder: identifies itself, normalizes Nominatim results and caches repeated searches", async () => {
  clearGeocodeCache();
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => [
    { place_id: 1, lat: "52.2297", lon: "21.0122", display_name: "Nowy Świat 1, Śródmieście, Warszawa, 00-497, Polska", name: "Nowy Świat 1", type: "house",
      address: { road: "Nowy Świat", house_number: "1", city: "Warszawa", postcode: "00-497", country: "Polska" } },
    { place_id: 2, lat: "x", lon: "21" },
  ] }; };
  const results = await geocodeSearch("  Nowy   Świat 1 ", { fetchImpl, language: "pl-PL,pl;q=0.9", env: {} });
  assert.deepEqual(results, [{ id: "1", name: "Nowy Świat 1", address: "Nowy Świat 1, 00-497 Warszawa, Polska", label: "Nowy Świat 1, Śródmieście, Warszawa, 00-497, Polska", latitude: 52.2297, longitude: 21.0122, category: "house" }]);
  const request = new URL(calls[0].url);
  assert.equal(request.origin + request.pathname, "https://nominatim.openstreetmap.org/search");
  assert.deepEqual([request.searchParams.get("q"), request.searchParams.get("format"), request.searchParams.get("limit"), request.searchParams.get("accept-language")], ["Nowy Świat 1", "jsonv2", "6", "pl-PL"]);
  assert.match(calls[0].options.headers["User-Agent"], /^TelnyxContactCenter\//);
  assert.deepEqual(await geocodeSearch("nowy świat 1", { fetchImpl, language: "pl-PL", env: {} }), results);
  assert.equal(calls.length, 1, "an identical query is served from the cache");
  await assert.rejects(geocodeSearch("ab", { fetchImpl, env: {} }), /at least 3 characters/);
  assert.equal(geocoderUserAgent({ APP_BASE_URL: "https://cc.example.com" }), "TelnyxContactCenter/1.0 (+https://cc.example.com)");
  assert.equal(normalizeGeocodeResult({ lat: "1", lon: "2", display_name: "Somewhere, Earth" }).address, "Somewhere, Earth");
});

test("location and contact builders follow the Telnyx contract; reactions accept one emoji or nothing", () => {
  assert.deepEqual(normalizeWhatsAppLocation({ latitude: " 52.2297000 ", longitude: 21.0122, name: " Office ", address: "Nowy Świat 1" }), { latitude: "52.2297", longitude: "21.0122", name: "Office", address: "Nowy Świat 1" });
  assert.deepEqual(buildWhatsAppLocationMessage({ latitude: 52.2297, longitude: 21.0122 }), { type: "location", location: { latitude: "52.2297", longitude: "21.0122" } });
  assert.throws(() => buildWhatsAppLocationMessage({ latitude: 95, longitude: 0 }), /Latitude/);
  assert.equal(describeWhatsAppContent({ kind: "location", text: "", location: { latitude: "52.23", longitude: "21.01", name: "", address: "" } }), "[Location: 52.23, 21.01]");
  const card = whatsappContactCard({ id: "c1", first_name: "Anna", last_name: "Nowak", display_name: "", company_name: "Telnyx", job_title: "CSM", mobile: "+48 600 000 001", phone: "+48600000001", business_phone_1: "22 123 45 67",
    email_address_1: "anna@example.com", email_address_2: "anna@example.com", address_city: "Warszawa", address_country: "PL" });
  assert.deepEqual(card, { name: { formatted_name: "Anna Nowak", first_name: "Anna", last_name: "Nowak" },
    phones: [{ phone: "+48600000001", type: "CELL", wa_id: "48600000001" }, { phone: "+22123 45 67".replace(/\s/g, "") === "+22123 45 67" ? "+221234567" : "+221234567", type: "WORK", wa_id: "221234567" }],
    emails: [{ email: "anna@example.com", type: "WORK" }], org: { company: "Telnyx", title: "CSM" }, addresses: [{ city: "Warszawa", country: "PL", type: "WORK" }] });
  assert.deepEqual(summarizeWhatsAppContacts([card]), [{ name: "Anna Nowak", phones: ["+48600000001", "+221234567"], emails: ["anna@example.com"], company: "Telnyx" }]);
  assert.equal(describeWhatsAppContent({ kind: "contacts", text: "", contacts: summarizeWhatsAppContacts([card]) }), "[Contact: Anna Nowak]");
  assert.deepEqual(buildWhatsAppContactsMessage([card]).type, "contacts");
  assert.throws(() => buildWhatsAppContactsMessage(Array.from({ length: WHATSAPP_MAX_CONTACTS + 1 }, () => card)), /at most/);
  assert.throws(() => whatsappContactCard({ id: "c2" }), /no name/);
  assert.deepEqual(buildWhatsAppReactionMessage({ messageId: "4031a0a5", emoji: "👍🏽" }), { type: "reaction", reaction: { message_id: "4031a0a5", emoji: "👍🏽" } });
  assert.deepEqual(buildWhatsAppReactionMessage({ messageId: "4031a0a5", emoji: "" }).reaction.emoji, "", "an empty emoji removes the reaction");
  assert.throws(() => buildWhatsAppReactionMessage({ messageId: "4031a0a5", emoji: "ok" }), /single emoji/);
});

test("annotations fold reactions onto the message they refer to and resolve quoted replies", () => {
  const wa = (extra) => ({ provider: "whatsapp", status: "received", kind: "text", content: {}, ...extra });
  const messages = [
    { id: "m1", sender_role: "agent", sender_id: "agent-1", body: "So what is your problem?", created_at: "t1", delivery: wa({ status: "delivered", provider_message_id: "tx-1" }) },
    { id: "m2", sender_role: "customer", sender_id: "+48", body: "😮", created_at: "t2", delivery: wa({ kind: "reaction", provider_message_id: "tx-2", content: { reaction: { message_id: "tx-1", emoji: "😮" } } }) },
    { id: "m3", sender_role: "customer", sender_id: "+48", body: "My order is late", created_at: "t3", delivery: wa({ provider_message_id: "tx-3", content: { context: { message_id: "tx-1" } } }) },
    { id: "m4", sender_role: "agent", sender_id: "agent-1", body: "Reacted 👍", created_at: "t4", delivery: wa({ status: "accepted", kind: "reaction", provider_message_id: "tx-4", content: { reaction: { message_id: "tx-3", emoji: "👍" } } }) },
    { id: "m5", sender_role: "agent", sender_id: "agent-1", body: "Removed reaction", created_at: "t5", delivery: wa({ status: "accepted", kind: "reaction", provider_message_id: "tx-5", content: { reaction: { message_id: "tx-3", emoji: "" } } }) },
    { id: "m6", sender_role: "customer", sender_id: "+48", body: "❤️", created_at: "t6", delivery: wa({ kind: "reaction", provider_message_id: "tx-6", content: { reaction: { message_id: "tx-unknown", emoji: "❤️" } } }) },
    { id: "m7", sender_role: "customer", sender_id: "+48", body: "👍", created_at: "t7", delivery: wa({ kind: "reaction", provider_message_id: "tx-7", content: { reaction: { message_id: "tx-1", emoji: "👍" } } }) },
  ];
  const folded = foldWhatsAppAnnotations(messages);
  assert.deepEqual(folded.map((m) => m.id), ["m1", "m3", "m6"], "matched reactions disappear as bubbles; unmatched ones stay");
  assert.deepEqual(folded[0].delivery.reactions.map((r) => [r.emoji, r.sender_role, r.message_id]), [["👍", "customer", "m7"]], "the customer's latest reaction replaces the earlier one");
  assert.deepEqual(folded[1].delivery.quoted, { message_id: "m1", sender_role: "agent", body: "So what is your problem?", kind: "text" });
  assert.deepEqual(folded[1].delivery.reactions, [], "the agent removed their reaction");
  assert.equal(folded[2].delivery.orphan_reaction, true);
});


test("device contact cards validate size and types and never forward private fields", () => {
  const [card] = normalizeWhatsAppDeviceContacts([{ display_name: "Ada", mobile: "+48 111 222 333", phone: "600 111 222",
    email_address_1: "ada@example.test", company_name: "Support", identifier: "iphone-secret", notes: "private note", photo: "private photo" }]);
  assert.equal(card.name.formatted_name, "Ada");
  assert.equal(card.phones[0].phone, "+48111222333");
  assert.equal(card.phones[1].phone, "600 111 222");
  assert.equal(card.phones[1].wa_id, undefined);
  assert.equal(JSON.stringify(card).includes("private"), false);
  assert.equal(JSON.stringify(card).includes("iphone-secret"), false);
  assert.throws(() => normalizeWhatsAppDeviceContacts([]), /between/);
  assert.throws(() => normalizeWhatsAppDeviceContacts(Array(6).fill({ display_name: "Ada" })), /between/);
  assert.throws(() => normalizeWhatsAppDeviceContacts([{ display_name: "x".repeat(121) }]), /Invalid/);
  assert.throws(() => normalizeWhatsAppDeviceContacts([{ display_name: {} }]), /Invalid/);
  assert.throws(() => normalizeWhatsAppDeviceContacts([{ mobile: "+48111222333" }]), /no name/);
});
