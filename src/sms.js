// Alfabeto GSM 03.38. Los caracteres de la tabla extendida consumen dos septetos.
const GSM_BASIC = new Set(Array.from(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
));
const GSM_EXTENDED = new Set(Array.from("\f^{}\\[~]|€"));

function analyzeSms(message) {
  let septets = 0;
  let gsm7 = true;
  for (const character of message) {
    if (GSM_BASIC.has(character)) septets += 1;
    else if (GSM_EXTENDED.has(character)) septets += 2;
    else {
      gsm7 = false;
      break;
    }
  }

  if (gsm7) {
    return {
      encoding: "GSM-7",
      units: septets,
      singlePartLimit: 160,
      multipartPartLimit: 153,
      parts: septets <= 160 ? 1 : Math.ceil(septets / 153),
    };
  }

  // Android/Java mide el texto Unicode en unidades UTF-16; un emoji suele consumir dos.
  const units = message.length;
  return {
    encoding: "UCS-2",
    units,
    singlePartLimit: 70,
    multipartPartLimit: 67,
    parts: units <= 70 ? 1 : Math.ceil(units / 67),
  };
}

module.exports = { analyzeSms };
