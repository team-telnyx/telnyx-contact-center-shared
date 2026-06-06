export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { seedDefaultAppSettings } from "@/lib/seed-app-settings.mjs";

// GET app settings
export async function GET() {
  try {
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database connection failed" },
        { status: 500 }
      );
    }

    const client = await pool.connect();
    try {
      // Check if theme_colors_hex column exists, if not add it
      const columnCheck = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'app_settings' AND column_name = 'theme_colors_hex'
      `);

      if (columnCheck.rows.length === 0) {
        // Add the missing column
        await client.query(`
          ALTER TABLE app_settings 
          ADD COLUMN theme_colors_hex JSONB DEFAULT '{"light": {}, "dark": {}}'::jsonb
        `);
      }

      const result = await client.query(
        "SELECT * FROM app_settings WHERE id = 'default' LIMIT 1"
      );

      if (result.rows.length === 0) {
        // Auto-seed default settings if none exist
        await seedDefaultAppSettings();

        // Fetch again after seeding
        const seededResult = await client.query(
          "SELECT * FROM app_settings WHERE id = 'default' LIMIT 1"
        );

        if (seededResult.rows.length > 0) {
          const settings = seededResult.rows[0];
          return NextResponse.json({
            themeColors: settings.theme_colors || { light: {}, dark: {} },
            themeColorsHex: settings.theme_colors_hex || {
              light: {},
              dark: {},
            },
            brandLogoUri: settings.brand_logo_uri || null,
            authRightImageUri: settings.auth_right_image_uri || null,
            sidebarLogoUri: settings.sidebar_logo_uri || null,
          });
        }

        // Fallback if seeding failed
        return NextResponse.json({
          themeColors: { light: {}, dark: {} },
          themeColorsHex: { light: {}, dark: {} },
          brandLogoUri: null,
          authRightImageUri: null,
          sidebarLogoUri: null,
        });
      }

      const settings = result.rows[0];
      return NextResponse.json({
        themeColors: settings.theme_colors || { light: {}, dark: {} },
        themeColorsHex: settings.theme_colors_hex || { light: {}, dark: {} },
        brandLogoUri: settings.brand_logo_uri || null,
        authRightImageUri: settings.auth_right_image_uri || null,
        sidebarLogoUri: settings.sidebar_logo_uri || null,
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error fetching app settings:", error);
    return NextResponse.json(
      { error: "Failed to fetch app settings" },
      { status: 500 }
    );
  }
}

// PUT app settings (admin/owner only)
export async function PUT(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is admin or owner
    // Get user from database to access roles
    const { PgDb } = await import("@/lib/pgdb");
    const dbUser = await PgDb.findUserById(session.user.id);
    if (!dbUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    const { isAdmin } = await import("@/lib/role-utils");
    if (!isAdmin(dbUser)) {
      return NextResponse.json(
        { error: "Forbidden: Admin access required" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const {
      themeColors,
      themeColorsHex,
      brandLogoUri,
      authRightImageUri,
      sidebarLogoUri,
    } = body;

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database connection failed" },
        { status: 500 }
      );
    }

    const client = await pool.connect();
    try {
      // Check if theme_colors_hex column exists, if not add it
      const columnCheck = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'app_settings' AND column_name = 'theme_colors_hex'
      `);

      if (columnCheck.rows.length === 0) {
        // Add the missing column
        await client.query(`
          ALTER TABLE app_settings 
          ADD COLUMN theme_colors_hex JSONB DEFAULT '{"light": {}, "dark": {}}'::jsonb
        `);
      }

      // Check if settings exist
      const checkResult = await client.query(
        "SELECT id FROM app_settings WHERE id = 'default' LIMIT 1"
      );

      const updateData = {
        theme_colors: themeColors || { light: {}, dark: {} },
        theme_colors_hex: themeColorsHex || { light: {}, dark: {} },
        brand_logo_uri: brandLogoUri || null,
        auth_right_image_uri: authRightImageUri || null,
        sidebar_logo_uri: sidebarLogoUri || null,
        updated_by: session.user.id,
        updated_at: new Date(),
      };

      if (checkResult.rows.length === 0) {
        // Insert new settings
        await client.query(
          `INSERT INTO app_settings (
            id, theme_colors, theme_colors_hex, brand_logo_uri, auth_right_image_uri, 
            sidebar_logo_uri, updated_by, updated_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            "default",
            JSON.stringify(updateData.theme_colors),
            JSON.stringify(updateData.theme_colors_hex),
            updateData.brand_logo_uri,
            updateData.auth_right_image_uri,
            updateData.sidebar_logo_uri,
            updateData.updated_by,
            updateData.updated_at,
            new Date(),
          ]
        );
      } else {
        // Update existing settings
        await client.query(
          `UPDATE app_settings SET
            theme_colors = $1,
            theme_colors_hex = $2,
            brand_logo_uri = $3,
            auth_right_image_uri = $4,
            sidebar_logo_uri = $5,
            updated_by = $6,
            updated_at = $7
          WHERE id = 'default'`,
          [
            JSON.stringify(updateData.theme_colors),
            JSON.stringify(updateData.theme_colors_hex),
            updateData.brand_logo_uri,
            updateData.auth_right_image_uri,
            updateData.sidebar_logo_uri,
            updateData.updated_by,
            updateData.updated_at,
          ]
        );
      }

      return NextResponse.json({ success: true });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error updating app settings:", error);
    return NextResponse.json(
      { error: "Failed to update app settings" },
      { status: 500 }
    );
  }
}
