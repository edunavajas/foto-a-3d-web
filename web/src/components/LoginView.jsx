import { useRef, useState } from 'react';
import { animate, motion } from 'motion/react';
import { readJson } from '../api.js';
import { Button } from './ui/button/button';
import { PasswordField } from './ui/password-field/password-field';
import { Card } from './ui/card/card';

/** Same refusal gesture the Arc dropzone uses: a short, decaying side-to-side shake. */
const SHAKE = { x: [0, -7, 6, -4, 3, -1.5, 0] };

export default function LoginView({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const cardRef = useRef(null);

  const shake = () => { if (cardRef.current) animate(cardRef.current, SHAKE, { duration: .42, ease: 'easeOut' }); };

  async function submit(event) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      await readJson(await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      }));
      onSuccess();
    } catch (caught) {
      setError(caught.message);
      shake();
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <motion.div
        ref={cardRef}
        className="w-full max-w-sm"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: .3, ease: [.16, 1, .3, 1] }}
      >
        <Card title="Foto a 3D" description="Introduce la contraseña para continuar.">
          <form onSubmit={submit} className="mt-5 grid gap-4" noValidate>
            <PasswordField
              label="Contraseña"
              value={password}
              onChange={event => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              aria-invalid={error ? true : undefined}
              messages={{ showPassword: 'Mostrar contraseña', hidePassword: 'Ocultar contraseña' }}
            />
            {error && (
              <p role="alert" className="text-sm" style={{ color: 'var(--danger)' }}>
                {error}
              </p>
            )}
            <Button type="submit" size="lg" loading={loading}>Entrar</Button>
          </form>
        </Card>
      </motion.div>
    </main>
  );
}
