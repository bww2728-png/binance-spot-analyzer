interface ToggleProps {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}

/** مفتاح تبديل موحد بدل مربعات الاختيار — RTL صحيح */
export default function Toggle({ on, onChange, label, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      data-on={on}
      className="toggle"
      onClick={() => onChange(!on)}
    />
  );
}
