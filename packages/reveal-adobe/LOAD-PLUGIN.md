# Loading reveal-adobe Plugin in UXP Developer Tool

## Error You're Seeing
```
Uncaught Error: Cannot resolve module: index.html
```

## Solution: Use the Correct Path

### ✅ CORRECT Path (use this):
```
/workspaces/electrosaur/reveal-project/packages/reveal-adobe/dist
```

### ❌ WRONG Path (do NOT use):
```
/workspaces/electrosaur/reveal-project/packages/reveal-adobe
```

## Steps to Load Plugin

1. **Open UXP Developer Tool**

2. **Click "Add Plugin"**

3. **Navigate to the dist folder:**
   ```
   /workspaces/electrosaur/reveal-project/packages/reveal-adobe/dist
   ```

4. **Select `manifest.json`** in the dist folder

5. **Click "Load"**

## Verify Your Files

The `dist/` folder should contain:
```
dist/
├── manifest.json  ✓
├── index.html     ✓
├── index.js       ✓
├── icons/
│   ├── icon_dark.png
│   └── icon_light.png
└── presets/
    └── (10 JSON files)
```

Run this to verify:
```bash
cd /workspaces/electrosaur/reveal-project/packages/reveal-adobe
ls -la dist/
```

## Troubleshooting

### If error persists:

1. **Rebuild the plugin:**
   ```bash
   cd /workspaces/electrosaur/reveal-project/packages/reveal-adobe
   npm run build
   ```

2. **Remove and re-add in UXP Developer Tool**
   - Remove the existing plugin entry
   - Add it again using the correct dist/ path

3. **Check file permissions:**
   ```bash
   cd dist
   chmod 644 manifest.json index.html index.js
   ```

4. **Compare with working reveal-photoshop:**
   The working plugin is at:
   ```
   /workspaces/electrosaur/reveal-photoshop/dist
   ```

   Try loading that one to confirm UXP is working correctly.

## Common Mistakes

1. ❌ Pointing to `/packages/reveal-adobe/` instead of `/packages/reveal-adobe/dist/`
2. ❌ Selecting `src/manifest.json` instead of `dist/manifest.json`
3. ❌ Having an old version of the plugin still loaded
4. ❌ Not rebuilding after making changes

## Build Output Verification

After `npm run build`, you should see:
```
✓ Copied manifest.json
✓ Copied index.html
✓ Copied icons/
✓ Copied presets/
Asset copying complete!
```

## Additional Info

- **Plugin Name:** Screen Printing
- **Plugin ID:** org.electrosaur.reveal
- **Version:** 0.13.0
- **Bundle Size:** 94KB (index.js)

If you continue to have issues, please share:
1. The exact path you're using in UXP Developer Tool
2. Screenshot of the folder you're selecting
3. Output of: `ls -la /workspaces/electrosaur/reveal-project/packages/reveal-adobe/dist/`
