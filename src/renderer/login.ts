import { loginEmail, registerEmail, loginGoogle } from './firebase';

declare global {
  interface Window {
    electron?: { loginSuccess: (d: object) => void; close: () => void; minimize: () => void; maximize: () => void; };
    switchTab: (t: string) => void;
    doLogin: () => void;
    doRegister: () => void;
    doGoogle: () => void;
  }
}

function showErr(msg: string) {
  (document.getElementById('err-msg') as HTMLElement).textContent = msg;
}

function setLoading(id: string, loading: boolean) {
  const btn = document.getElementById(id) as HTMLButtonElement;
  btn.disabled = loading;
  btn.textContent = loading ? 'Please wait…' : (id === 'btn-login' ? 'PLAY' : 'CREATE ACCOUNT');
}

function onSuccess(data: { uid: string; name: string }) {
  if (window.electron) {
    window.electron.loginSuccess(data);
  } else {
    // dev fallback — redirect to game page in browser
    sessionStorage.setItem('userData', JSON.stringify(data));
    window.location.href = './game.html';
  }
}

window.switchTab = (tab: string) => {
  const isLogin = tab === 'login';
  (document.getElementById('form-login')    as HTMLElement).style.display = isLogin ? '' : 'none';
  (document.getElementById('form-register') as HTMLElement).style.display = isLogin ? 'none' : '';
  (document.getElementById('tab-login')     as HTMLElement).classList.toggle('active', isLogin);
  (document.getElementById('tab-register')  as HTMLElement).classList.toggle('active', !isLogin);
  showErr('');
};

window.doLogin = async () => {
  const email    = (document.getElementById('l-email')    as HTMLInputElement).value.trim();
  const password = (document.getElementById('l-password') as HTMLInputElement).value;
  if (!email || !password) { showErr('Fill in all fields.'); return; }
  setLoading('btn-login', true);
  try {
    const data = await loginEmail(email, password);
    onSuccess(data);
  } catch (e: any) {
    showErr(friendlyError(e.code));
    setLoading('btn-login', false);
  }
};

window.doRegister = async () => {
  const name     = (document.getElementById('r-name')     as HTMLInputElement).value.trim();
  const email    = (document.getElementById('r-email')    as HTMLInputElement).value.trim();
  const password = (document.getElementById('r-password') as HTMLInputElement).value;
  if (!name || !email || !password) { showErr('Fill in all fields.'); return; }
  if (password.length < 6) { showErr('Password must be at least 6 characters.'); return; }
  setLoading('btn-register', true);
  try {
    const data = await registerEmail(email, password, name);
    onSuccess(data);
  } catch (e: any) {
    showErr(friendlyError(e.code));
    setLoading('btn-register', false);
  }
};

window.doGoogle = async () => {
  try {
    const data = await loginGoogle();
    onSuccess(data);
  } catch (e: any) {
    showErr(friendlyError(e.code));
  }
};

function friendlyError(code: string): string {
  const map: Record<string, string> = {
    'auth/invalid-credential':      'Wrong email or password.',
    'auth/email-already-in-use':    'Email already registered.',
    'auth/weak-password':           'Password too weak.',
    'auth/invalid-email':           'Invalid email address.',
    'auth/user-not-found':          'No account with that email.',
    'auth/popup-closed-by-user':    'Sign-in cancelled.',
  };
  return map[code] ?? 'Something went wrong. Try again.';
}
