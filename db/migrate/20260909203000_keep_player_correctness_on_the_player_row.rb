# The students list aggregated every answer ever recorded, on every load. Each
# player's correct and scored counts now live on their row, computed when the
# game finishes, so the list reads player rows instead of the whole answers
# table. Ported from the Node version (main, commit 7649d92).
class KeepPlayerCorrectnessOnThePlayerRow < ActiveRecord::Migration[8.1]
  def up
    add_column :game_players, :correct, :integer, null: false, default: 0
    add_column :game_players, :scored, :integer, null: false, default: 0

    # Existing games keep their reports: fill the counts from the answers they
    # already hold, which is the same sum the list used to do on every load.
    execute <<~SQL
      UPDATE game_players SET
        correct = COALESCE((SELECT SUM(CASE WHEN a.correct = 1 THEN 1 ELSE 0 END) FROM game_answers a
                            WHERE a.game_id = game_players.game_id AND a.player = game_players.name), 0),
        scored  = COALESCE((SELECT COUNT(*) FROM game_answers a
                            WHERE a.game_id = game_players.game_id AND a.player = game_players.name
                              AND a.correct IS NOT NULL), 0)
    SQL

    # This served that aggregate and nothing else. Every remaining query on
    # game_answers filters by game_id, which the unique index below already
    # leads with, and answers are written far more often than they are read:
    # an index here is paid for on the hot path of a running game.
    remove_index :game_answers, :game_id
  end

  def down
    add_index :game_answers, :game_id
    remove_column :game_players, :scored
    remove_column :game_players, :correct
  end
end
