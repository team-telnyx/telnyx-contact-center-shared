// Language code to name and flag mapping for transcription services
// ISO 639-1 (2-letter) language codes

export const languages = [
  // Special
  { code: "auto", name: "Auto (experimental)", flag: "🌐" },
  { code: "multi", name: "Multilingual (No audio hint)", flag: "🌐" },

  // Languages A-Z
  { code: "sq", name: "Albanian", flag: "🇦🇱" },
  { code: "am", name: "Amharic", flag: "🇪🇹" },
  { code: "ar", name: "Arabic", flag: "🇸🇦" },
  { code: "hy", name: "Armenian", flag: "🇦🇲" },
  { code: "as", name: "Assamese", flag: "🇮🇳" },
  { code: "az", name: "Azerbaijani", flag: "🇦🇿" },
  { code: "ba", name: "Bashkir", flag: "🇷🇺" },
  { code: "eu", name: "Basque", flag: "🇪🇸" },
  { code: "be", name: "Belarusian", flag: "🇧🇾" },
  { code: "bn", name: "Bengali", flag: "🇧🇩" },
  { code: "bs", name: "Bosnian", flag: "🇧🇦" },
  { code: "br", name: "Breton", flag: "🇫🇷" },
  { code: "bg", name: "Bulgarian", flag: "🇧🇬" },
  { code: "my", name: "Burmese", flag: "🇲🇲" },
  { code: "ca", name: "Catalan", flag: "🇪🇸" },
  { code: "zh", name: "Chinese", flag: "🇨🇳" },
  { code: "hr", name: "Croatian", flag: "🇭🇷" },
  { code: "cs", name: "Czech", flag: "🇨🇿" },
  { code: "da", name: "Danish", flag: "🇩🇰" },
  { code: "nl", name: "Dutch", flag: "🇳🇱" },
  { code: "en", name: "English", flag: "🇬🇧" },
  { code: "et", name: "Estonian", flag: "🇪🇪" },
  { code: "fo", name: "Faroese", flag: "🇫🇴" },
  { code: "fa", name: "Persian", flag: "🇮🇷" },
  { code: "fi", name: "Finnish", flag: "🇫🇮" },
  { code: "fr", name: "French", flag: "🇫🇷" },
  { code: "gl", name: "Galician", flag: "🇪🇸" },
  { code: "ka", name: "Georgian", flag: "🇬🇪" },
  { code: "de", name: "German", flag: "🇩🇪" },
  { code: "el", name: "Greek", flag: "🇬🇷" },
  { code: "gu", name: "Gujarati", flag: "🇮🇳" },
  { code: "ht", name: "Haitian Creole", flag: "🇭🇹" },
  { code: "ha", name: "Hausa", flag: "🇳🇬" },
  { code: "he", name: "Hebrew", flag: "🇮🇱" },
  { code: "hi", name: "Hindi", flag: "🇮🇳" },
  { code: "hu", name: "Hungarian", flag: "🇭🇺" },
  { code: "is", name: "Icelandic", flag: "🇮🇸" },
  { code: "id", name: "Indonesian", flag: "🇮🇩" },
  { code: "it", name: "Italian", flag: "🇮🇹" },
  { code: "ja", name: "Japanese", flag: "🇯🇵" },
  { code: "jv", name: "Javanese", flag: "🇮🇩" },
  { code: "jw", name: "Javanese", flag: "🇮🇩" },
  { code: "kn", name: "Kannada", flag: "🇮🇳" },
  { code: "kk", name: "Kazakh", flag: "🇰🇿" },
  { code: "km", name: "Khmer", flag: "🇰🇭" },
  { code: "ko", name: "Korean", flag: "🇰🇷" },
  { code: "ku", name: "Kurdish", flag: "🇮🇶" },
  { code: "ky", name: "Kyrgyz", flag: "🇰🇬" },
  { code: "lo", name: "Lao", flag: "🇱🇦" },
  { code: "la", name: "Latin", flag: "🇻🇦" },
  { code: "lv", name: "Latvian", flag: "🇱🇻" },
  { code: "ln", name: "Lingala", flag: "🇨🇩" },
  { code: "lt", name: "Lithuanian", flag: "🇱🇹" },
  { code: "lb", name: "Luxembourgish", flag: "🇱🇺" },
  { code: "mk", name: "Macedonian", flag: "🇲🇰" },
  { code: "mg", name: "Malagasy", flag: "🇲🇬" },
  { code: "ms", name: "Malay", flag: "🇲🇾" },
  { code: "ml", name: "Malayalam", flag: "🇮🇳" },
  { code: "mt", name: "Maltese", flag: "🇲🇹" },
  { code: "mi", name: "Maori", flag: "🇳🇿" },
  { code: "mr", name: "Marathi", flag: "🇮🇳" },
  { code: "mn", name: "Mongolian", flag: "🇲🇳" },
  { code: "ne", name: "Nepali", flag: "🇳🇵" },
  { code: "no", name: "Norwegian", flag: "🇳🇴" },
  { code: "nn", name: "Norwegian Nynorsk", flag: "🇳🇴" },
  { code: "oc", name: "Occitan", flag: "🇫🇷" },
  { code: "or", name: "Odia", flag: "🇮🇳" },
  { code: "ps", name: "Pashto", flag: "🇦🇫" },
  { code: "pl", name: "Polish", flag: "🇵🇱" },
  { code: "pt", name: "Portuguese", flag: "🇵🇹" },
  { code: "pa", name: "Punjabi", flag: "🇮🇳" },
  { code: "ro", name: "Romanian", flag: "🇷🇴" },
  { code: "ru", name: "Russian", flag: "🇷🇺" },
  { code: "sa", name: "Sanskrit", flag: "🇮🇳" },
  { code: "gd", name: "Scottish Gaelic", flag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿" },
  { code: "sr", name: "Serbian", flag: "🇷🇸" },
  { code: "sn", name: "Shona", flag: "🇿🇼" },
  { code: "sd", name: "Sindhi", flag: "🇵🇰" },
  { code: "si", name: "Sinhala", flag: "🇱🇰" },
  { code: "sk", name: "Slovak", flag: "🇸🇰" },
  { code: "sl", name: "Slovenian", flag: "🇸🇮" },
  { code: "so", name: "Somali", flag: "🇸🇴" },
  { code: "st", name: "Sotho", flag: "🇿🇦" },
  { code: "es", name: "Spanish", flag: "🇪🇸" },
  { code: "su", name: "Sundanese", flag: "🇮🇩" },
  { code: "sw", name: "Swahili", flag: "🇰🇪" },
  { code: "sv", name: "Swedish", flag: "🇸🇪" },
  { code: "tl", name: "Tagalog", flag: "🇵🇭" },
  { code: "tg", name: "Tajik", flag: "🇹🇯" },
  { code: "ta", name: "Tamil", flag: "🇮🇳" },
  { code: "tt", name: "Tatar", flag: "🇷🇺" },
  { code: "te", name: "Telugu", flag: "🇮🇳" },
  { code: "th", name: "Thai", flag: "🇹🇭" },
  { code: "bo", name: "Tibetan", flag: "🇨🇳" },
  { code: "tr", name: "Turkish", flag: "🇹🇷" },
  { code: "tw", name: "Twi", flag: "🇬🇭" },
  { code: "tk", name: "Turkmen", flag: "🇹🇲" },
  { code: "ug", name: "Uyghur", flag: "🇨🇳" },
  { code: "uk", name: "Ukrainian", flag: "🇺🇦" },
  { code: "ur", name: "Urdu", flag: "🇵🇰" },
  { code: "uz", name: "Uzbek", flag: "🇺🇿" },
  { code: "vi", name: "Vietnamese", flag: "🇻🇳" },
  { code: "cy", name: "Welsh", flag: "🏴󠁧󠁢󠁷󠁬󠁳󠁿" },
  { code: "fy", name: "Western Frisian", flag: "🇳🇱" },
  { code: "xh", name: "Xhosa", flag: "🇿🇦" },
  { code: "yi", name: "Yiddish", flag: "🇮🇱" },
  { code: "yo", name: "Yoruba", flag: "🇳🇬" },
  { code: "zu", name: "Zulu", flag: "🇿🇦" },
];

/**
 * Get language info by code
 * @param {string} code - Language code (e.g., "en", "es", "en-US", "zh-CN")
 * @returns {Object} Language object with code, name, and flag
 */
export function getLanguageByCode(code) {
  if (!code) {
    return { code: "unknown", name: "Unknown", flag: "🌐" };
  }

  // First try exact match
  const exactMatch = languages.find(
    (l) => l.code.toLowerCase() === code.toLowerCase()
  );
  if (exactMatch) {
    return exactMatch;
  }

  // Handle regional codes (e.g., "en-US", "zh-CN", "pt-BR")
  if (code.includes("-") || code.includes("_")) {
    const separator = code.includes("-") ? "-" : "_";
    const [baseCode, region] = code.split(separator);

    const baseLang = languages.find(
      (l) => l.code.toLowerCase() === baseCode.toLowerCase()
    );

    if (baseLang) {
      // Get region name from countries if available
      const regionUpper = region.toUpperCase();
      const regionNames = {
        US: "United States",
        GB: "United Kingdom",
        AU: "Australia",
        CA: "Canada",
        IN: "India",
        NZ: "New Zealand",
        ZA: "South Africa",
        IE: "Ireland",
        CN: "China",
        TW: "Taiwan",
        HK: "Hong Kong",
        SG: "Singapore",
        MY: "Malaysia",
        BR: "Brazil",
        PT: "Portugal",
        MX: "Mexico",
        ES: "Spain",
        AR: "Argentina",
        CL: "Chile",
        CO: "Colombia",
        DE: "Germany",
        AT: "Austria",
        CH: "Switzerland",
        FR: "France",
        BE: "Belgium",
        IT: "Italy",
        NL: "Netherlands",
        SE: "Sweden",
        NO: "Norway",
        DK: "Denmark",
        FI: "Finland",
        PL: "Poland",
        RU: "Russia",
        UA: "Ukraine",
        CZ: "Czech Republic",
        SK: "Slovakia",
        HU: "Hungary",
        RO: "Romania",
        BG: "Bulgaria",
        GR: "Greece",
        TR: "Turkey",
        IL: "Israel",
        SA: "Saudi Arabia",
        AE: "UAE",
        EG: "Egypt",
        ZA: "South Africa",
        KR: "South Korea",
        JP: "Japan",
        TH: "Thailand",
        ID: "Indonesia",
        PH: "Philippines",
        VN: "Vietnam",
        HANS: "Simplified",
        HANT: "Traditional",
        419: "Latin America",
      };

      const regionName = regionNames[regionUpper] || regionUpper;
      return {
        code: code,
        name: `${baseLang.name} (${regionName})`,
        flag: baseLang.flag,
      };
    }
  }

  // Fallback for completely unknown codes
  return {
    code: code,
    name: code.toUpperCase(),
    flag: "🌐",
  };
}

/**
 * Get multiple languages info by codes
 * @param {Array<string>} codes - Array of language codes
 * @returns {Array<Object>} Array of language objects
 */
export function getLanguagesByCodes(codes) {
  if (!Array.isArray(codes)) return [];
  return codes.map((code) => getLanguageByCode(code));
}
