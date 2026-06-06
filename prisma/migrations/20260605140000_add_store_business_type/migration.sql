-- CreateEnum
CREATE TYPE "StoreBusinessType" AS ENUM (
    'convenience_store',
    'grocery_store',
    'supermarket',
    'liquor_store',
    'smoke_shop',
    'vape_shop',
    'gas_station',
    'pharmacy',
    'clothing_store',
    'shoe_store',
    'jewelry_store',
    'gift_shop',
    'electronics_store',
    'phone_store',
    'computer_store',
    'hardware_store',
    'home_improvement_store',
    'furniture_store',
    'auto_parts',
    'beauty_store',
    'pet_store',
    'bookstore',
    'toy_store',
    'flower_shop',
    'wholesale',
    'other'
);

-- AlterTable
ALTER TABLE "Store" ADD COLUMN "businessType" "StoreBusinessType" NOT NULL DEFAULT 'other';
