# Testing the Contact Center App

## Quick Start

1. **Start the development server:**

   ```bash
   yarn dev
   ```

2. **Open your browser:**
   Navigate to `http://localhost:3000`

## What to Test

### 1. Home Page

- Navigate to `http://localhost:3000`
- Should show the Contact Center home page

### 2. Sidebar Navigation

- **Left Sidebar:**
  - Should show "AGENT" menu
  - Click to expand and see:
    - Desktop
    - Configuration
  - Click on each to navigate

### 3. User Profile (Bottom Menu)

- Click on the user avatar in the bottom left
- Should see dropdown with:
  - Theme switching (Light/Dark/System)
  - User Profile link
- Click "User Profile" to navigate to `/profile`

### 4. Profile Page

- Navigate to `/profile`
- Should show profile tabs:
  - Profile tab
  - Settings tab with theme switching

### 5. Theme Switching

- Use the dropdown in bottom menu or profile page
- Switch between Light/Dark/System themes
- Page should update immediately

## Current Status

✅ **Working:**

- Database and schema created
- Basic routing and navigation
- Sidebar with menu structure
- Theme switching
- Profile page layout

⚠️ **Mock/Placeholder:**

- Authentication (returns mock user)
- Profile updates (not persisted to DB yet)
- API endpoints return mock data

## Next Steps for Full Implementation

1. **Authentication:**

   - Implement NextAuth.js
   - Add signin/signup pages
   - Connect to database

2. **Profile Persistence:**

   - Connect profile API to PostgreSQL
   - Save theme preferences
   - Save user settings

3. **Agent Desktop:**

   - Implement call handling UI
   - Connect to Telnyx Voice API
   - Add WebRTC integration

4. **Configuration:**
   - Skills management
   - Agent groups configuration
   - Routing rules

## Troubleshooting

- **Port 3000 already in use:**

  ```bash
  # Kill process on port 3000
  lsof -ti:3000 | xargs kill -9
  ```

- **Database connection errors:**

  - Check `.env.local` has correct PostgreSQL credentials
  - Ensure database exists: `yarn ensure:pg`

- **Missing assets:**
  - Logo and avatar files should be in `public/` directory
  - If missing, copy from telnyx-demo-portal-nextjs project
