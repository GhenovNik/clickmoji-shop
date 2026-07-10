import Link from 'next/link';
import { ShoppingCart, Star, History, ArrowRight } from 'lucide-react';
import InteractiveCart from '@/components/ui/InteractiveCart';

export default function Home() {
  return (
    <div className="min-h-[78vh] md:min-h-[85vh] flex flex-col items-center justify-start md:justify-center py-8 sm:py-10 px-4 sm:px-6 bg-gradient-to-b from-blue-50/50 to-white">
      <div className="max-w-3xl w-full text-center space-y-7 sm:space-y-8">
        {/* Hero Section */}
        <div className="space-y-4 sm:space-y-5">
          <InteractiveCart />

          <h1 className="text-4xl sm:text-5xl md:text-6xl font-black text-gray-900 tracking-tight leading-tight font-heading">
            Покупки с <span className="text-primary">ClickMoji</span>
          </h1>

          <p className="text-base sm:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Визуальные списки покупок вместо скучного текста. Собирайте корзину легко, быстро и
            наглядно с помощью эмодзи!
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row flex-wrap items-center justify-center gap-3 sm:gap-4 pt-2 sm:pt-3">
          <Link
            href="/categories"
            className="w-full sm:w-auto bg-primary hover:bg-primary/90 text-primary-foreground px-6 py-3 rounded-2xl font-bold text-base sm:text-lg shadow-lg hover:shadow-xl hover:-translate-y-1 transition-all flex items-center justify-center gap-2 group"
          >
            <ShoppingCart className="w-5 h-5" />
            <span>Открыть каталог</span>
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </Link>
          <Link
            href="/lists"
            className="w-full sm:w-auto bg-white hover:bg-gray-50 text-foreground border-2 border-border px-6 py-3 rounded-2xl font-bold text-base sm:text-lg transition-all flex items-center justify-center gap-2 hover:-translate-y-1 hover:shadow-md"
          >
            <ShoppingCart className="w-5 h-5 text-muted-foreground" />
            <span>Мои списки</span>
          </Link>
          <Link
            href="/history"
            className="w-full sm:w-auto bg-white hover:bg-gray-50 text-foreground border-2 border-border px-6 py-3 rounded-2xl font-bold text-base sm:text-lg transition-all flex items-center justify-center gap-2 hover:-translate-y-1 hover:shadow-md"
          >
            <History className="w-5 h-5 text-muted-foreground" />
            <span>История покупок</span>
          </Link>
        </div>

        {/* Quick Features */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 pt-5 sm:pt-8">
          <div className="bento-card p-4 sm:p-5 text-left space-y-3 hover:-translate-y-1 transition-transform">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-bold text-foreground text-base sm:text-lg">Умные списки</h3>
              <div className="w-10 h-10 bg-primary/10 text-primary rounded-xl flex items-center justify-center shrink-0">
                <ShoppingCart className="w-5 h-5" />
              </div>
            </div>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Создавайте списки в пару кликов и собирайте покупки быстрее
            </p>
          </div>

          <div className="bento-card p-4 sm:p-5 text-left space-y-3 hover:-translate-y-1 transition-transform">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-bold text-foreground text-base sm:text-lg">Избранное</h3>
              <div className="w-10 h-10 bg-secondary/20 text-secondary-foreground rounded-xl flex items-center justify-center shrink-0">
                <Star className="w-5 h-5" />
              </div>
            </div>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Частые товары всегда под рукой в специальном разделе
            </p>
          </div>

          <Link
            href="/history"
            className="bento-card p-4 sm:p-5 text-left space-y-3 hover:shadow-md hover:-translate-y-1 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-bold text-foreground text-base sm:text-lg">История</h3>
              <div className="w-10 h-10 bg-accent/20 text-accent-foreground rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                <History className="w-5 h-5" />
              </div>
            </div>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Сохраняйте прошлые покупки, чтобы легко их повторять
            </p>
          </Link>
        </div>
      </div>
    </div>
  );
}
