-- Sample KB Articles for Contact Center Agent Assist
-- Run this script in your PostgreSQL database to populate kb_articles table
-- Usage: psql -d your_database -f scripts/seed-kb-articles.sql

-- Clear existing sample articles (optional - comment out if you want to keep existing data)
-- DELETE FROM kb_articles WHERE username = 'system';

-- Insert sample KB articles
INSERT INTO kb_articles (
  id, username, title, slug, summary, content, category, subcategory, 
  tags, keywords, author_name, status, language, published_at
) VALUES

-- Printer Issues
(
  'kb-001',
  'system',
  'How to Fix Printer Not Responding',
  'printer-not-responding',
  'Troubleshooting steps for when your printer is not responding to print jobs.',
  'If your printer is not responding, follow these steps:

1. Check the printer power and connection:
   - Ensure the printer is turned on and connected to power
   - Verify USB cable is securely connected (for wired printers)
   - Check wireless connection status (for network printers)

2. Restart the printer:
   - Turn off the printer
   - Wait 30 seconds
   - Turn it back on

3. Check printer queue:
   - Open Printers & Scanners settings
   - Clear any stuck print jobs
   - Try printing a test page

4. Reinstall printer driver:
   - Remove the printer from your system
   - Download latest driver from manufacturer website
   - Reinstall and add printer again

If the issue persists, contact IT support with the printer model and error messages.',
  'Hardware',
  'Printers',
  ARRAY['printer', 'hardware', 'troubleshooting'],
  ARRAY['printer not working', 'printer offline', 'print queue'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '30 days'
),

(
  'kb-002',
  'system',
  'Network Printer Setup Guide',
  'network-printer-setup',
  'Step-by-step instructions for setting up a network printer on Windows and Mac.',
  'Setting up a network printer:

Windows:
1. Open Settings > Devices > Printers & Scanners
2. Click "Add a printer or scanner"
3. Select "Add a printer using an IP address or hostname"
4. Enter the printer IP address
5. Install the printer driver when prompted

Mac:
1. Open System Preferences > Printers & Scanners
2. Click the "+" button
3. Select "IP" tab
4. Enter printer IP address or hostname
5. Choose printer driver from the list

Common Issues:
- Ensure printer and computer are on the same network
- Check firewall settings if printer is not discovered
- Verify printer IP address is correct

For assistance, provide the printer model and your operating system version.',
  'Hardware',
  'Printers',
  ARRAY['network printer', 'setup', 'configuration'],
  ARRAY['printer setup', 'network printer', 'add printer'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '25 days'
),

-- Network Issues
(
  'kb-003',
  'system',
  'WiFi Connection Problems',
  'wifi-connection-problems',
  'Troubleshooting guide for WiFi connectivity issues.',
  'If you are experiencing WiFi connection problems:

1. Check WiFi is enabled:
   - Look for WiFi icon in system tray
   - Ensure airplane mode is off
   - Check WiFi toggle in settings

2. Restart network adapter:
   - Windows: Device Manager > Network Adapters > Right-click > Disable, then Enable
   - Mac: Turn WiFi off and on in System Preferences

3. Forget and reconnect:
   - Remove the network from saved networks
   - Reconnect and enter password again

4. Check router:
   - Verify router is powered on
   - Check if other devices can connect
   - Try restarting the router

5. Update network driver:
   - Download latest driver from manufacturer
   - Install and restart computer

6. Check IP configuration:
   - Ensure DHCP is enabled
   - Try releasing and renewing IP address

If problems persist, contact IT with your device model and network name.',
  'Network',
  'WiFi',
  ARRAY['wifi', 'network', 'connectivity'],
  ARRAY['wifi not working', 'cannot connect', 'network issues'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '20 days'
),

(
  'kb-004',
  'system',
  'Ethernet Cable Connection Issues',
  'ethernet-cable-issues',
  'How to troubleshoot wired network connection problems.',
  'Troubleshooting Ethernet connection:

1. Check physical connection:
   - Ensure cable is securely plugged into both computer and router/switch
   - Try a different Ethernet port
   - Test with a different cable if available

2. Check network adapter:
   - Verify adapter is enabled in Device Manager
   - Check for driver updates
   - Disable and re-enable the adapter

3. Verify network settings:
   - Check IP configuration (should be automatic/DHCP)
   - Ensure no static IP conflicts
   - Verify DNS settings

4. Test connection:
   - Check if link light is on (usually green/orange)
   - Try pinging the router/gateway
   - Test internet connectivity

5. Check for network restrictions:
   - Verify MAC address is not blocked
   - Check if port is enabled on switch
   - Confirm VLAN configuration if applicable

Contact IT support with your computer model and network location if issue persists.',
  'Network',
  'Ethernet',
  ARRAY['ethernet', 'wired network', 'cable'],
  ARRAY['ethernet not working', 'wired connection', 'network cable'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '18 days'
),

-- Password & Account Issues
(
  'kb-005',
  'system',
  'Password Reset Instructions',
  'password-reset-instructions',
  'How to reset your account password through the self-service portal.',
  'To reset your password:

1. Go to the password reset portal: https://portal.company.com/reset
2. Enter your username or email address
3. Click "Send Reset Link"
4. Check your email for the reset link (check spam folder if not received)
5. Click the link in the email (valid for 1 hour)
6. Enter your new password:
   - Minimum 12 characters
   - Must include uppercase, lowercase, number, and special character
   - Cannot be a previously used password

If you do not receive the email:
- Check spam/junk folder
- Verify email address is correct
- Wait 5 minutes and try again
- Contact IT support if still not received

After resetting:
- You may need to update password in mobile devices
- Some applications may require re-authentication
- VPN connections will need new password

For assistance, contact IT support with your username.',
  'Account',
  'Password',
  ARRAY['password', 'reset', 'account'],
  ARRAY['password reset', 'forgot password', 'change password'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '15 days'
),

(
  'kb-006',
  'system',
  'Account Locked - How to Unlock',
  'account-locked-unlock',
  'Steps to unlock your account after multiple failed login attempts.',
  'If your account is locked due to multiple failed login attempts:

1. Wait 15 minutes - accounts automatically unlock after 15 minutes
2. Try logging in again with correct password
3. If still locked, contact IT support

To prevent future lockouts:
- Use password manager to store passwords securely
- Enable two-factor authentication
- Be careful with Caps Lock and keyboard layout
- Clear browser cache if experiencing issues

Common causes of account lockouts:
- Incorrect password entered multiple times
- Expired password not updated
- Caps Lock enabled
- Wrong keyboard layout (QWERTY vs AZERTY)

If you need immediate access:
- Contact IT support during business hours
- Provide your username and employee ID
- Be prepared to verify your identity

IT support can unlock your account remotely. Response time is typically within 15 minutes during business hours.',
  'Account',
  'Security',
  ARRAY['account locked', 'unlock', 'login'],
  ARRAY['account locked', 'cannot login', 'unlock account'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '12 days'
),

-- Email Issues
(
  'kb-007',
  'system',
  'Email Not Sending - Troubleshooting',
  'email-not-sending',
  'Common solutions for when emails are not being sent.',
  'If your emails are not sending:

1. Check internet connection:
   - Verify you are connected to network
   - Test internet connectivity

2. Check email settings:
   - Verify SMTP server settings are correct
   - Check port numbers (usually 587 or 465)
   - Ensure authentication is enabled

3. Check outbox:
   - Look for stuck messages in outbox
   - Delete and resend if necessary
   - Check for large attachments (over 25MB may fail)

4. Check email quota:
   - Verify mailbox is not full
   - Delete old emails or archive them
   - Check sent items folder size

5. Restart email client:
   - Close and reopen Outlook/Thunderbird
   - Sign out and sign back in
   - Clear application cache

6. Check for error messages:
   - Look for bounce-back messages
   - Check error codes in email client
   - Review server logs if accessible

Common error codes:
- 550: Mailbox unavailable
- 552: Mailbox full
- 553: Invalid recipient

Contact IT support with error message and recipient address if issue persists.',
  'Email',
  'Sending',
  ARRAY['email', 'sending', 'outlook'],
  ARRAY['email not sending', 'cannot send email', 'outbox'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '10 days'
),

(
  'kb-008',
  'system',
  'Email Not Receiving Messages',
  'email-not-receiving',
  'Troubleshooting steps when you are not receiving emails.',
  'If you are not receiving emails:

1. Check spam/junk folder:
   - Important emails may be filtered
   - Mark legitimate emails as "Not Spam"
   - Add sender to contacts/whitelist

2. Check email filters:
   - Review inbox rules and filters
   - Disable filters temporarily to test
   - Check if emails are being forwarded

3. Verify email address:
   - Confirm sender has correct email address
   - Check for typos in email address
   - Verify email is not bouncing back to sender

4. Check mailbox storage:
   - Ensure mailbox is not full
   - Delete old emails or archive
   - Check storage quota

5. Check email client sync:
   - Force sync in mobile email app
   - Refresh inbox in webmail
   - Restart email client

6. Check server status:
   - Verify email server is operational
   - Check for maintenance notifications
   - Review service status page

7. Test with different sender:
   - Ask colleague to send test email
   - Try sending email to yourself
   - Check if external emails are blocked

If still not receiving emails, contact IT support with:
- Email addresses you should have received from
- Timeframe of missing emails
- Any error messages received',
  'Email',
  'Receiving',
  ARRAY['email', 'receiving', 'inbox'],
  ARRAY['not receiving email', 'missing emails', 'inbox'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '8 days'
),

-- Software Issues
(
  'kb-009',
  'system',
  'Software Installation Failed',
  'software-installation-failed',
  'How to resolve common software installation errors.',
  'If software installation fails:

1. Check system requirements:
   - Verify operating system version compatibility
   - Check available disk space (need at least 2GB free)
   - Ensure minimum RAM requirements are met

2. Run as administrator:
   - Right-click installer
   - Select "Run as administrator"
   - Enter admin credentials if prompted

3. Disable antivirus temporarily:
   - Some antivirus may block installations
   - Temporarily disable real-time protection
   - Re-enable after installation

4. Check for conflicting software:
   - Uninstall previous versions
   - Remove conflicting applications
   - Check for software conflicts

5. Download fresh installer:
   - Delete current installer
   - Download new copy from official source
   - Verify file integrity (checksum)

6. Check Windows updates:
   - Install pending Windows updates
   - Restart computer
   - Try installation again

7. Check installation logs:
   - Review error messages carefully
   - Check Windows Event Viewer
   - Look for specific error codes

Common error codes:
- 1603: Installation failed
- 1935: Assembly installation error
- 2503/2502: Permission errors

Contact IT support with:
- Software name and version
- Error message or code
- Operating system version',
  'Software',
  'Installation',
  ARRAY['software', 'installation', 'error'],
  ARRAY['install failed', 'installation error', 'cannot install'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '6 days'
),

(
  'kb-010',
  'system',
  'Application Crashes or Freezes',
  'application-crashes',
  'Troubleshooting steps for applications that crash or freeze.',
  'If an application crashes or freezes:

1. Close and restart:
   - Force close the application (Task Manager)
   - Wait 30 seconds
   - Restart the application

2. Check for updates:
   - Update application to latest version
   - Install pending Windows/Mac updates
   - Update graphics drivers

3. Clear application cache:
   - Close application
   - Clear cache/temp files
   - Restart application

4. Check system resources:
   - Open Task Manager (Ctrl+Shift+Esc)
   - Check CPU and memory usage
   - Close unnecessary applications

5. Run in compatibility mode:
   - Right-click application shortcut
   - Properties > Compatibility
   - Try different compatibility settings

6. Reinstall application:
   - Uninstall completely
   - Restart computer
   - Reinstall from official source

7. Check for conflicts:
   - Disable browser extensions
   - Close other applications
   - Check for software conflicts

8. Check error logs:
   - Review application error logs
   - Check Windows Event Viewer
   - Look for crash reports

If issue persists:
- Note when crashes occur (specific actions)
- Document error messages
- Contact IT support with application name and version',
  'Software',
  'Troubleshooting',
  ARRAY['crash', 'freeze', 'application'],
  ARRAY['application crash', 'program freeze', 'not responding'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '5 days'
),

-- VPN & Remote Access
(
  'kb-011',
  'system',
  'VPN Connection Problems',
  'vpn-connection-problems',
  'How to troubleshoot VPN connectivity issues.',
  'If you cannot connect to VPN:

1. Check internet connection:
   - Verify you have active internet
   - Test connection to other websites
   - Check if VPN is required for your location

2. Verify VPN credentials:
   - Ensure username is correct
   - Check password (watch for Caps Lock)
   - Verify account is not locked

3. Check VPN server address:
   - Verify server address is correct
   - Try alternative server if available
   - Check if server is operational

4. Update VPN client:
   - Install latest VPN client version
   - Check for client updates
   - Reinstall if necessary

5. Check firewall/antivirus:
   - Temporarily disable firewall
   - Check if antivirus is blocking VPN
   - Add VPN to firewall exceptions

6. Check network adapter:
   - Verify network adapter is enabled
   - Update network drivers
   - Restart network adapter

7. Clear VPN cache:
   - Sign out of VPN client
   - Clear cache and settings
   - Sign back in

8. Try different network:
   - Test from different WiFi network
   - Try mobile hotspot
   - Check if network blocks VPN

Common error messages:
- "Connection timeout": Server may be down
- "Authentication failed": Check credentials
- "Cannot reach server": Check server address

Contact IT support with:
- VPN client name and version
- Error message
- Your location/network',
  'Network',
  'VPN',
  ARRAY['vpn', 'remote access', 'connectivity'],
  ARRAY['vpn not connecting', 'cannot connect vpn', 'vpn error'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '4 days'
),

-- Browser Issues
(
  'kb-012',
  'system',
  'Browser Not Loading Websites',
  'browser-not-loading',
  'Troubleshooting steps when browser cannot load websites.',
  'If your browser is not loading websites:

1. Check internet connection:
   - Verify you are connected to internet
   - Test with different website
   - Check network status

2. Clear browser cache:
   - Clear browsing data
   - Clear cookies and cache
   - Restart browser

3. Disable browser extensions:
   - Disable all extensions
   - Test if sites load
   - Re-enable one by one

4. Check DNS settings:
   - Try different DNS server (8.8.8.8)
   - Flush DNS cache
   - Restart network adapter

5. Try different browser:
   - Test in Chrome, Firefox, Edge
   - If one works, issue is browser-specific
   - Update or reinstall problematic browser

6. Check proxy settings:
   - Verify proxy configuration
   - Disable proxy if not needed
   - Check corporate proxy settings

7. Reset browser settings:
   - Reset to default settings
   - Clear all browsing data
   - Restart browser

8. Check firewall:
   - Verify firewall is not blocking browser
   - Add browser to exceptions
   - Check corporate firewall rules

Common issues:
- "This site can''t be reached": DNS or connection issue
- "ERR_CONNECTION_REFUSED": Server or firewall issue
- "ERR_NAME_NOT_RESOLVED": DNS resolution problem

Contact IT support with:
- Browser name and version
- Error message
- Websites that are not loading',
  'Software',
  'Browser',
  ARRAY['browser', 'website', 'loading'],
  ARRAY['browser not working', 'cannot load website', 'website error'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '3 days'
),

-- Hardware Issues
(
  'kb-013',
  'system',
  'Computer Running Slow',
  'computer-running-slow',
  'Steps to improve computer performance and speed.',
  'If your computer is running slow:

1. Check running programs:
   - Open Task Manager (Ctrl+Shift+Esc)
   - Close unnecessary applications
   - End high CPU/memory processes

2. Free up disk space:
   - Delete temporary files
   - Empty Recycle Bin
   - Remove unused programs
   - Clear browser cache

3. Check for malware:
   - Run full antivirus scan
   - Check for malware with Malwarebytes
   - Remove detected threats

4. Update software:
   - Install Windows/Mac updates
   - Update drivers
   - Update applications

5. Check startup programs:
   - Disable unnecessary startup items
   - Reduce programs that auto-start
   - Use Task Manager startup tab

6. Add more RAM (if possible):
   - Check current RAM usage
   - Consider upgrading RAM
   - Close memory-intensive programs

7. Defragment hard drive (HDD only):
   - Run disk defragmentation
   - Optimize drive
   - Not needed for SSD

8. Check for hardware issues:
   - Monitor CPU temperature
   - Check hard drive health
   - Verify RAM is functioning

9. Restart computer:
   - Restart to clear memory
   - Close all programs first
   - Allow full restart

If still slow after these steps, contact IT support with:
- Computer model and age
- Current RAM and storage
- Specific performance issues',
  'Hardware',
  'Performance',
  ARRAY['slow', 'performance', 'speed'],
  ARRAY['computer slow', 'performance issues', 'lagging'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '2 days'
),

(
  'kb-014',
  'system',
  'External Monitor Not Detected',
  'external-monitor-not-detected',
  'How to fix issues with external monitor not being recognized.',
  'If your external monitor is not detected:

1. Check physical connections:
   - Verify cable is securely connected
   - Try different cable if available
   - Check both ends of connection
   - Try different port on computer

2. Check monitor power:
   - Ensure monitor is turned on
   - Check power indicator light
   - Try different power outlet

3. Check display settings:
   - Windows: Settings > Display > Detect
   - Mac: System Preferences > Displays > Detect Displays
   - Use keyboard shortcut (Windows+P / Mac brightness)

4. Update graphics driver:
   - Download latest driver from manufacturer
   - Install and restart computer
   - Check for driver updates

5. Check cable compatibility:
   - Verify cable type (HDMI, DisplayPort, VGA, USB-C)
   - Ensure cable supports your resolution
   - Try adapter if needed

6. Test with different monitor:
   - Connect different monitor to test
   - If works, issue is with original monitor
   - If doesn''t work, issue is with computer/port

7. Check display port:
   - Try different port on computer
   - Check if port is enabled in BIOS
   - Verify port is not damaged

8. Restart with monitor connected:
   - Shut down computer
   - Connect monitor
   - Power on monitor first, then computer

Common issues:
- Monitor shows "No Signal": Connection or cable issue
- Monitor detected but black screen: Driver or settings issue
- Flickering display: Cable or refresh rate issue

Contact IT support with:
- Computer model
- Monitor model
- Cable type being used',
  'Hardware',
  'Display',
  ARRAY['monitor', 'display', 'external'],
  ARRAY['monitor not detected', 'external display', 'second monitor'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '1 day'
),

-- Mobile Device Issues
(
  'kb-015',
  'system',
  'Mobile Device Email Setup',
  'mobile-email-setup',
  'Instructions for setting up corporate email on mobile devices.',
  'Setting up corporate email on mobile device:

iPhone/iPad:
1. Go to Settings > Mail > Accounts
2. Tap "Add Account"
3. Select "Exchange" or "Microsoft Exchange"
4. Enter your email address
5. Enter password
6. Server: mail.company.com
7. Domain: COMPANY (if required)
8. Tap "Next" and verify settings

Android:
1. Open Email app
2. Tap "Add Account"
3. Select "Exchange" or "Corporate"
4. Enter email and password
5. Enter server settings:
   - Server: mail.company.com
   - Port: 443
   - Security: SSL/TLS
6. Complete setup

Manual IMAP Settings:
- Incoming: imap.company.com, Port 993, SSL
- Outgoing: smtp.company.com, Port 587, TLS
- Username: full email address
- Password: your email password

Two-Factor Authentication:
- May require app-specific password
- Generate in account settings
- Use app password instead of regular password

Troubleshooting:
- Verify email and password are correct
- Check device is connected to internet
- Ensure server addresses are correct
- Contact IT if setup fails

For assistance, contact IT support with:
- Device type and model
- Operating system version
- Error message if any',
  'Email',
  'Mobile',
  ARRAY['mobile', 'email', 'setup'],
  ARRAY['mobile email', 'phone email setup', 'corporate email'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '5 hours'
),

-- Security Issues
(
  'kb-016',
  'system',
  'Suspicious Email - What to Do',
  'suspicious-email',
  'How to identify and handle suspicious or phishing emails.',
  'If you receive a suspicious email:

1. Do NOT click links or open attachments
2. Do NOT reply to the email
3. Do NOT provide personal information

Signs of suspicious emails:
- Unexpected sender or unusual email address
- Urgent language or threats
- Requests for personal information
- Poor grammar or spelling
- Suspicious links or attachments
- Generic greetings instead of your name

What to do:
1. Report to IT security:
   - Forward email to security@company.com
   - Include full email headers if possible
   - Do not forward to others

2. Delete the email:
   - Remove from inbox
   - Empty deleted items
   - Check spam folder

3. If you clicked a link:
   - Change your password immediately
   - Run antivirus scan
   - Contact IT security immediately
   - Monitor accounts for suspicious activity

4. If you opened an attachment:
   - Do not open any files
   - Run full antivirus scan
   - Contact IT security immediately
   - Disconnect from network if advised

5. If you provided information:
   - Change passwords immediately
   - Contact IT security
   - Monitor financial accounts
   - Consider credit monitoring

Prevention:
- Be cautious with unexpected emails
- Verify sender before responding
- Check email addresses carefully
- Use two-factor authentication
- Keep software updated

Contact IT security immediately if you believe you have been compromised.',
  'Security',
  'Phishing',
  ARRAY['phishing', 'security', 'email'],
  ARRAY['suspicious email', 'phishing', 'security threat'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '3 hours'
),

-- File Access Issues
(
  'kb-017',
  'system',
  'Cannot Access Network Drive',
  'cannot-access-network-drive',
  'Troubleshooting steps when network drive is not accessible.',
  'If you cannot access a network drive:

1. Check network connection:
   - Verify you are connected to network
   - Check if you can access other network resources
   - Verify VPN is connected if working remotely

2. Check drive mapping:
   - Verify drive letter is correct
   - Check if drive is still mapped
   - Remap the drive if necessary

3. Verify permissions:
   - Ensure you have access rights
   - Check with your manager if access was removed
   - Verify your account is active

4. Check drive path:
   - Verify network path is correct
   - Test path in File Explorer
   - Check if server name changed

5. Reconnect to drive:
   - Disconnect existing mapping
   - Map drive again with correct path
   - Enter credentials if prompted

6. Check server status:
   - Verify file server is operational
   - Check for maintenance notifications
   - Contact IT if server is down

7. Clear credentials:
   - Remove saved credentials
   - Re-enter username and password
   - Use format: DOMAIN\username

8. Restart computer:
   - Sometimes resolves connection issues
   - Clears network cache
   - Re-establishes connections

Common error messages:
- "Network path not found": Incorrect path or server down
- "Access denied": Permission issue
- "Drive already mapped": Drive letter conflict

Contact IT support with:
- Network drive path
- Error message
- Your username',
  'Network',
  'File Access',
  ARRAY['network drive', 'file access', 'mapping'],
  ARRAY['cannot access drive', 'network drive', 'file server'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '2 hours'
),

-- Audio/Video Issues
(
  'kb-018',
  'system',
  'Microphone Not Working',
  'microphone-not-working',
  'How to fix microphone issues for video calls and recordings.',
  'If your microphone is not working:

1. Check physical connection:
   - Verify microphone is plugged in
   - Check USB connection if wireless
   - Try different USB port
   - Test with different microphone

2. Check microphone permissions:
   - Windows: Settings > Privacy > Microphone
   - Mac: System Preferences > Security > Microphone
   - Ensure apps have microphone access

3. Set as default device:
   - Windows: Sound Settings > Input
   - Select your microphone as default
   - Adjust input volume

4. Check microphone settings:
   - Verify microphone is not muted
   - Increase microphone volume
   - Check input levels

5. Update audio drivers:
   - Download latest audio drivers
   - Install and restart computer
   - Check manufacturer website

6. Test microphone:
   - Use built-in sound recorder
   - Test in different applications
   - Check if issue is app-specific

7. Check application settings:
   - Verify microphone is selected in app
   - Check app permissions
   - Review audio settings

8. Restart audio services:
   - Windows: Restart Windows Audio service
   - Mac: Restart computer
   - Clear audio cache

Common issues:
- Microphone shows as "Not plugged in": Connection or driver issue
- No sound input: Permissions or settings issue
- Low volume: Increase input level or check microphone

For video calls:
- Test in Teams/Zoom settings
- Check app-specific microphone settings
- Verify app has microphone permission

Contact IT support with:
- Microphone model
- Application being used
- Error message if any',
  'Hardware',
  'Audio',
  ARRAY['microphone', 'audio', 'video call'],
  ARRAY['mic not working', 'microphone', 'audio input'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '1 hour'
),

(
  'kb-019',
  'system',
  'Webcam Not Working',
  'webcam-not-working',
  'Troubleshooting steps for webcam issues during video calls.',
  'If your webcam is not working:

1. Check physical connection:
   - Verify webcam is connected (USB)
   - Try different USB port
   - Check if webcam light is on
   - Test with different webcam

2. Check camera permissions:
   - Windows: Settings > Privacy > Camera
   - Mac: System Preferences > Security > Camera
   - Ensure apps have camera access

3. Close other applications:
   - Only one app can use camera at a time
   - Close other video apps
   - Restart the application

4. Set as default device:
   - Windows: Settings > Devices > Cameras
   - Select your webcam
   - Verify it is enabled

5. Update drivers:
   - Download latest webcam drivers
   - Install and restart computer
   - Check manufacturer website

6. Test camera:
   - Use built-in camera app
   - Test in different applications
   - Check if issue is app-specific

7. Check application settings:
   - Verify camera is selected in app
   - Check app permissions
   - Review video settings

8. Restart computer:
   - Sometimes resolves camera issues
   - Clears camera cache
   - Re-initializes devices

Common issues:
- Camera shows as "Not available": Permission or driver issue
- Black screen: Camera in use by another app
- Poor quality: Check camera settings and lighting

For video calls:
- Test in Teams/Zoom settings
- Check app-specific camera settings
- Verify app has camera permission
- Ensure good lighting

Contact IT support with:
- Webcam model
- Application being used
- Error message if any',
  'Hardware',
  'Video',
  ARRAY['webcam', 'camera', 'video'],
  ARRAY['webcam not working', 'camera', 'video call'],
  'IT Support Team',
  'Published',
  'en',
  NOW() - INTERVAL '30 minutes'
),

-- General IT Support
(
  'kb-020',
  'system',
  'How to Contact IT Support',
  'contact-it-support',
  'Information on how to reach IT support for assistance.',
  'Contact IT Support:

Phone Support:
- Main line: (555) 123-4567
- Hours: Monday-Friday, 8:00 AM - 6:00 PM EST
- For urgent issues, press 1 for priority queue

Email Support:
- General: support@company.com
- Security issues: security@company.com
- Response time: Within 4 business hours

Self-Service Portal:
- URL: https://portal.company.com
- Log in with your company credentials
- Submit tickets, check status, view knowledge base

Live Chat:
- Available in self-service portal
- Hours: Monday-Friday, 9:00 AM - 5:00 PM EST
- Average response: 5-10 minutes

When contacting support, please provide:
- Your name and employee ID
- Description of the issue
- Error messages (screenshot if possible)
- Steps you have already tried
- Computer/device model and operating system
- Application names and versions

For urgent issues:
- System-wide outages
- Security incidents
- Critical business applications down
- Data loss or corruption

After-hours support:
- Available for critical issues only
- Call main line and follow prompts
- Response time may be longer

Remote Support:
- IT can remotely access your computer
- Requires your permission
- Available during business hours
- Secure and monitored session',
  'General',
  'Support',
  ARRAY['support', 'contact', 'help'],
  ARRAY['it support', 'contact', 'help desk'],
  'IT Support Team',
  'Published',
  'en',
  NOW()
);

-- Update search vectors for all inserted articles (trigger should handle this, but we can force update)
UPDATE kb_articles SET updated_at = NOW() WHERE username = 'system';

-- Verify inserts
SELECT COUNT(*) as total_articles, 
       COUNT(*) FILTER (WHERE status = 'Published') as published_articles
FROM kb_articles 
WHERE username = 'system';

