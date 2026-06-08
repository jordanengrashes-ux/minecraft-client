import { loginEmail, registerEmail, loginGoogle, auth } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';

const errEl       = document.getElementById('err-msg')      as HTMLElement;
const btnLogin    = document.getElementById('btn-login')     as HTMLButtonElement;
const btnRegister = document.getElementById('btn-register')  as HTMLButtonElement;
const btnGoogle   = document.getElementById('btn-google')    as HTMLButtonElement;
const tabLogin    = document.getElementById('tab-login')     as HTMLButtonElement;
const tabRegister = document.getElementById('tab-register')  as HTMLButtonElement;
const formLogin   = document.getElementById('form-login')    as HTMLElement;
const formRegister= document.getElementById('form-register') as HTMLElement;
const card        = document.querySelector('.card')          as HTMLElement;

// title bar
document.getElementById('btn-minimize')!.addEventListener('click', () => window.electron?.minimize());
document.getElementById('close')!       .addEventListener('click', () => window.electron?.close());

function showErr(msg: string) { errEl.textContent = msg; }
function setLoading(btn: HTMLButtonElement, loading: boolean, label: string) {
  btn.disabled = loading;
  btn.textContent = loading ? 'Please wait…' : label;
}
function onSuccess(data: { uid: string; name: string }) {
  if (window.electron) {
    window.electron.saveFirebaseUser?.(data);
    window.electron.loginSuccess(data);
  } else {
    sessionStorage.setItem('userData', JSON.stringify(data));
    window.location.href = './game.html';
  }
}

// ── Check for existing session (auto-login) ───────────────────────────────────
// Hide everything while we check auth state
document.body.style.visibility = 'hidden';

async function checkAutoLogin() {
  // Fast path: disk-cached user (reliable across Electron restarts)
  if (window.electron?.loadFirebaseUser) {
    const cached = await window.electron.loadFirebaseUser();
    if (cached?.uid) {
      // Verify Firebase still considers this user valid (IndexedDB backup check)
      const unsub = onAuthStateChanged(auth, (user) => {
        unsub();
        if (user) {
          onSuccess({ uid: user.uid, name: user.displayName || user.email?.split('@')[0] || cached.name || 'Player' });
        } else {
          // Firebase session expired — clear disk cache, show login
          window.electron?.clearFirebaseUser?.();
          document.body.style.visibility = 'visible';
        }
      });
      return;
    }
  }
  // No disk cache — use Firebase auth state only
  const unsub = onAuthStateChanged(auth, (user) => {
    unsub();
    if (user) {
      onSuccess({ uid: user.uid, name: user.displayName || user.email?.split('@')[0] || 'Player' });
    } else {
      document.body.style.visibility = 'visible';
    }
  });
}

checkAutoLogin();

// ── Tab switching ─────────────────────────────────────────────────────────────
tabLogin.addEventListener('click', () => {
  formLogin.style.display    = '';
  formRegister.style.display = 'none';
  tabLogin.classList.add('active');
  tabRegister.classList.remove('active');
  showErr('');
});
tabRegister.addEventListener('click', () => {
  formLogin.style.display    = 'none';
  formRegister.style.display = '';
  tabLogin.classList.remove('active');
  tabRegister.classList.add('active');
  showErr('');
});

// ── Login ─────────────────────────────────────────────────────────────────────
btnLogin.addEventListener('click', async () => {
  const email    = (document.getElementById('l-email')    as HTMLInputElement).value.trim();
  const password = (document.getElementById('l-password') as HTMLInputElement).value;
  if (!email || !password) { showErr('Fill in all fields.'); return; }
  setLoading(btnLogin, true, 'PLAY');
  try {
    onSuccess(await loginEmail(email, password));
  } catch (e: any) {
    showErr(friendlyError(e.code));
    setLoading(btnLogin, false, 'PLAY');
  }
});

// ── Register ──────────────────────────────────────────────────────────────────
btnRegister.addEventListener('click', async () => {
  const name     = (document.getElementById('r-name')     as HTMLInputElement).value.trim();
  const email    = (document.getElementById('r-email')    as HTMLInputElement).value.trim();
  const password = (document.getElementById('r-password') as HTMLInputElement).value;
  if (!name || !email || !password) { showErr('Fill in all fields.'); return; }
  if (password.length < 6) { showErr('Password must be at least 6 characters.'); return; }
  setLoading(btnRegister, true, 'CREATE ACCOUNT');
  try {
    onSuccess(await registerEmail(email, password, name));
  } catch (e: any) {
    showErr(friendlyError(e.code));
    setLoading(btnRegister, false, 'CREATE ACCOUNT');
  }
});

// ── Google ────────────────────────────────────────────────────────────────────
btnGoogle.addEventListener('click', async () => {
  btnGoogle.disabled = true;
  try {
    onSuccess(await loginGoogle());
  } catch (e: any) {
    showErr(friendlyError(e.code));
    btnGoogle.disabled = false;
  }
});

// ── Enter key ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (formLogin.style.display !== 'none') btnLogin.click();
  else btnRegister.click();
});

function friendlyError(code: string): string {
  const map: Record<string, string> = {
    'auth/invalid-credential':   'Wrong email or password.',
    'auth/email-already-in-use': 'Email already registered.',
    'auth/weak-password':        'Password too weak.',
    'auth/invalid-email':        'Invalid email address.',
    'auth/user-not-found':       'No account with that email.',
    'auth/popup-closed-by-user': 'Sign-in cancelled.',
  };
  return map[code] ?? 'Something went wrong. Try again.';
}

// suppress unused warning
void card;

declare global {
  interface Window {
    electron?: {
      loginSuccess:      (d: object) => void;
      close:             () => void;
      minimize:          () => void;
      maximize:          () => void;
      saveFirebaseUser?: (d: object) => void;
      loadFirebaseUser?: () => Promise<{ uid: string; name: string } | null>;
      clearFirebaseUser?:() => void;
    };
  }
}
