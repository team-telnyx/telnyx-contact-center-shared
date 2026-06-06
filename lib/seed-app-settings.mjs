import { createDiagnosticLogger } from "./diagnostic-logger.mjs";
import { getPostgresPool } from "./postgres.mjs";
import { join } from "path";
import { parseColorsFromCSS } from "./parse-css-colors.mjs";

const seedLogger = createDiagnosticLogger("app");

/**
 * Seed default app settings with default colors and images
 * This function reads default colors from CSS and converts them to hex
 */
export async function seedDefaultAppSettings() {
  try {
    const pool = getPostgresPool();
    if (!pool) {
      seedLogger.error("seed_app_settings_db_unavailable");
      return false;
    }

    const client = await pool.connect();
    try {
      // Set a shorter statement timeout for this operation
      await client.query("SET statement_timeout = '5s'");

      // Check if settings already exist
      const checkResult = await client.query(
        "SELECT id, theme_colors, theme_colors_hex FROM app_settings WHERE id = 'default' LIMIT 1"
      );

      // Extract default theme colors from globals.css
      const cssPath = join(process.cwd(), "app", "globals.css");
      const parsedColors = parseColorsFromCSS(cssPath);

      // Validate that we got colors
      if (
      Object.keys(parsedColors.light).length === 0 &&
      Object.keys(parsedColors.dark).length === 0)
      {
        seedLogger.error("seed_app_settings_colors_parse_failed");


        return false;
      }

      const defaultThemeColors = {
        light: parsedColors.light || {},
        dark: parsedColors.dark || {}
      };

      const defaultThemeColorsHex = {
        light: parsedColors.lightHex || {},
        dark: parsedColors.darkHex || {}
      };

      if (checkResult.rows.length > 0) {
        const existing = checkResult.rows[0];
        const existingColors = existing.theme_colors || { light: {}, dark: {} };
        const existingColorsHex = existing.theme_colors_hex || {
          light: {},
          dark: {}
        };

        // Check if colors are empty and need to be filled
        const lightEmpty =
        !existingColors.light ||
        Object.keys(existingColors.light).length === 0;
        const darkEmpty =
        !existingColors.dark || Object.keys(existingColors.dark).length === 0;

        // Check if hex values are empty
        const lightHexEmpty =
        !existingColorsHex.light ||
        Object.keys(existingColorsHex.light).length === 0;
        const darkHexEmpty =
        !existingColorsHex.dark ||
        Object.keys(existingColorsHex.dark).length === 0;

        if (lightEmpty || darkEmpty || lightHexEmpty || darkHexEmpty) {
          // Update with default colors from CSS
          const updatedColors = {
            light: lightEmpty ? defaultThemeColors.light : existingColors.light,
            dark: darkEmpty ? defaultThemeColors.dark : existingColors.dark
          };
          const updatedColorsHex = {
            light: lightHexEmpty ?
            defaultThemeColorsHex.light :
            existingColorsHex.light,
            dark: darkHexEmpty ?
            defaultThemeColorsHex.dark :
            existingColorsHex.dark
          };

          await client.query(
            `UPDATE app_settings SET
              theme_colors = $1,
              theme_colors_hex = $2,
              updated_by = $3,
              updated_at = $4
            WHERE id = 'default'`,
            [
            JSON.stringify(updatedColors),
            JSON.stringify(updatedColorsHex),
            "system",
            new Date()]

          );

          seedLogger.info("seed_app_settings_colors_updated");






        } else {
          seedLogger.info("seed_app_settings_exists");


        }
        return true;
      }

      // Default images - null means use default images from public folder
      const defaultBrandLogoUri = null; // Will use /auth_brand_logo.png
      const defaultAuthRightImageUri = null; // Will use /auth_right_image.png
      const defaultSidebarLogoUri = null; // Will use /sidebar_logo.png

      seedLogger.info("seed_app_settings_colors_extracted");






      seedLogger.info("seed_app_settings_hex_values_extracted");





      // Insert default settings with ON CONFLICT to handle race conditions
      await client.query(
        `INSERT INTO app_settings (
          id, theme_colors, theme_colors_hex, brand_logo_uri, auth_right_image_uri, 
          sidebar_logo_uri, updated_by, updated_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO NOTHING`,
        [
        "default",
        JSON.stringify(defaultThemeColors),
        JSON.stringify(defaultThemeColorsHex),
        defaultBrandLogoUri,
        defaultAuthRightImageUri,
        defaultSidebarLogoUri,
        "system",
        new Date(),
        new Date()]

      );

      seedLogger.info("seed_app_settings_created");
      return true;
    } finally {
      // Reset statement timeout
      try {
        await client.query("RESET statement_timeout");
      } catch (e) {

        // Ignore reset errors
      }client.release();
    }
  } catch (error) {
    // Don't log timeout errors as critical - they're expected in some cases
    if (error.code === "57014") {
      seedLogger.info("seed_app_settings_timeout");


    } else {
      seedLogger.error("seed_app_settings_failed");
    }
    return false;
  }
}
