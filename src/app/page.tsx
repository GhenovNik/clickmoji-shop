import Link from 'next/link';
import { ShoppingCart, Star, History, ArrowRight } from 'lucide-react';
import InteractiveCart from '@/components/ui/InteractiveCart';

export default function Home() {
  return (
    <div className="min-h-[85vh] flex flex-col items-center justify-center py-12 px-6 bg-gradient-to-b from-blue-50/50 to-white">
      <div className="max-w-3xl w-full text-center space-y-10">
        {/* Hero Section */}
        <div className="space-y-6">
          <InteractiveCart />

          <h1 className="text-5xl sm:text-6xl font-black text-gray-900 tracking-tight leading-tight font-heading">
            Покупки с <span className="text-primary">ClickMoji</span>
          </h1>

          <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Визуальные списки покупок вместо скучного текста. Собирайте корзину легко, быстро и
            наглядно с помощью эмодзи!
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row flex-wrap items-center justify-center gap-4 pt-4">
          <Link
            href="/lists"
            className="w-full sm:w-auto bg-primary hover:bg-primary/90 text-primary-foreground px-8 py-4 rounded-2xl font-bold text-lg shadow-lg hover:shadow-xl hover:-translate-y-1 transition-all flex items-center justify-center gap-2 group"
          >
            <span>Мои списки</span>
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </Link>
          <Link
            href="/categories"
            className="w-full sm:w-auto bg-white hover:bg-gray-50 text-foreground border-2 border-border px-8 py-4 rounded-2xl font-bold text-lg transition-all flex items-center justify-center gap-2 hover:-translate-y-1 hover:shadow-md"
          >
            <ShoppingCart className="w-5 h-5 text-muted-foreground" />
            <span>Каталог товаров</span>
          </Link>
          <Link
            href="/history"
            className="w-full sm:w-auto bg-white hover:bg-gray-50 text-foreground border-2 border-border px-8 py-4 rounded-2xl font-bold text-lg transition-all flex items-center justify-center gap-2 hover:-translate-y-1 hover:shadow-md"
          >
            <History className="w-5 h-5 text-muted-foreground" />
            <span>История покупок</span>
          </Link>
        </div>

        {/* Quick Features */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 pt-16">
          <div className="bento-card p-6 flex flex-col items-center text-center gap-3 hover:-translate-y-1 transition-transform">
            <div className="w-14 h-14 bg-primary/10 text-primary rounded-2xl flex items-center justify-center">
              <ShoppingCart className="w-7 h-7" />
            </div>
            <h3 className="font-bold text-foreground text-lg">Умные списки</h3>
            <p className="text-muted-foreground text-sm">
              Создавайте списки в пару кликов и собирайте покупки быстрее
            </p>
          </div>

          <div className="bento-card p-6 flex flex-col items-center text-center gap-3 hover:-translate-y-1 transition-transform">
            <div className="w-14 h-14 bg-secondary/20 text-secondary-foreground rounded-2xl flex items-center justify-center">
              <Star className="w-7 h-7" />
            </div>
            <h3 className="font-bold text-foreground text-lg">Избранное</h3>
            <p className="text-muted-foreground text-sm">
              Частые товары всегда под рукой в специальном разделе
            </p>
          </div>

          <Link
            href="/history"
            className="bento-card p-6 flex flex-col items-center text-center gap-3 hover:shadow-md hover:-translate-y-1 transition-all cursor-pointer group"
          >
            <div className="w-14 h-14 bg-accent/20 text-accent-foreground rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform">
              <History className="w-7 h-7" />
            </div>
            <h3 className="font-bold text-foreground text-lg">История</h3>
            <p className="text-muted-foreground text-sm">
              Сохраняйте прошлые покупки, чтобы легко их повторять
            </p>
          </Link>
        </div>
      </div>
    </div>
  );
}
