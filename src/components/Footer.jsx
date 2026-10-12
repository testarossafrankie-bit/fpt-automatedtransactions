export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="max-w-7xl mx-auto px-4 py-3 text-center text-xs text-slate-500">
        Developed by FPT / © {year} F Terragrossa LLC. All Rights Reserved.
      </div>
    </footer>
  );
}
