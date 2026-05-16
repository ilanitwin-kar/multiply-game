# הרפתקאת הכפל

משחק לוח הכפל (PWA) — שלבים, כוכבים, בוסים, טבלאות 0–12.

## פריסה ב-Vercel (מומלץ)

1. העלו את הפרויקט ל-GitHub (ראו למטה).
2. ב-[vercel.com](https://vercel.com) → **Add New Project** → בחרו את הריפו.
3. Vercel קורא את `vercel.json` אוטומטית — **אין צורך בהגדרות Build מיוחדות**.
4. אחרי הפריסה תקבלו כתובת `https://….vercel.app` עם HTTPS — מתאים לנייד והתקנה כאפליקציה.

## העלאה ל-GitHub

מתוך תיקיית הפרויקט:

```bash
git init
git add .
git commit -m "Initial commit: multiply game PWA"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

(החליפו את כתובת ה-remote בשם המשתמש והריפו שלכם.)

## פיתוח מקומי

```bash
npm run dev
```

פתיחה בדפדפן: `http://localhost:5173`

לבדיקה בנייד עם HTTPS (בלי אזהרת «לא מאובטח»):

```bash
npm run dev
# בטרמינל נוסף:
npm run tunnel
```

## מבנה

| נתיב | תיאור |
|------|--------|
| `www/` | האתר — `index.html`, Service Worker, מניפסט |
| `vercel.json` | הגדרות פריסה סטטית ל-Vercel |
| `capacitor.config.json` | אופציונלי — בניית APK באנדרואיד |

## APK (אופציונלי)

```bash
npm install
npx cap add android
npx cap sync
npx cap open android
```
