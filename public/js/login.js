/** Login screen: sends the password and opens the app once the session cookie is set. */
const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const button = form.querySelector('button');

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  errorBox.hidden = true;
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: form.elements.password.value }),
    });
    if (response.ok) {
      location.replace('/');
      return;
    }
    const data = await response.json().catch(() => null);
    showError(data?.error ?? `Login failed (${response.status})`);
    form.elements.password.select();
  } catch {
    showError('Cannot reach Foodlog. Check your connection.');
  } finally {
    button.disabled = false;
  }
});
