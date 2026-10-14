/*
 * poc.ld - PocketStation 用リンカスクリプト
 *
 * 0x02000000-0x0200017F : SCヘッダ / PSアイコン / 実行アイコンリスト (ビルダーが生成)
 * 0x02000180-           : Body (このスクリプトで配置するコード)
 * 0x00000200-0x000007FF : ユーザーRAM (1.5KB, スタック上端 0x800)
 */
ENTRY(_start)

MEMORY
{
    FLASH (rx)  : ORIGIN = 0x02000180, LENGTH = 0x1E000 - 0x180
    RAM   (rwx) : ORIGIN = 0x00000200, LENGTH = 0x600
}

SECTIONS
{
    .pocinfo : { KEEP(*(.pocinfo)) } > FLASH

    .text : ALIGN(4)
    {
        KEEP(*(.text.start))
        *(.text .text.*)
        *(.rodata .rodata.*)
        . = ALIGN(4);
    } > FLASH

    .data : ALIGN(4)
    {
        __data_start = .;
        *(.data .data.*)
        . = ALIGN(4);
        __data_end = .;
    } > RAM AT > FLASH
    __data_load = LOADADDR(.data);

    .bss (NOLOAD) : ALIGN(4)
    {
        __bss_start = .;
        *(.bss .bss.* COMMON)
        . = ALIGN(4);
        __bss_end = .;
    } > RAM

    __stack_top = 0x800;

    /DISCARD/ : { *(.ARM.exidx*) *(.ARM.attributes) *(.comment) }
}
